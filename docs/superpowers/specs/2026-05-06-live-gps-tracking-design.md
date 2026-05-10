# Live GPS Tracking Tool — Design Spec

**Goal:** Add a standalone Live Tracking tool to the Tools tab that reads LoRa GPS telemetry from a USB-connected ground station via the Web Serial API and plots the rocket's flight path on a Leaflet map in real time.

**Architecture:** Browser-only — no backend changes. The Web Serial API runs in the browser on the host machine, bypassing Docker serial port passthrough entirely. GPS fixes accumulate in React state and update the Leaflet map imperatively (same pattern as `TrajectoryMap`).

**Tech Stack:** Web Serial API, Leaflet, React, TypeScript. No new npm dependencies.

---

## Wire Format

Ground station firmware outputs one UTF-8 line per GPS fix at 115200 baud:

```
lat,lon,alt_m,speed_ms,heading_deg[,rssi][,snr]\n
```

Example:
```
39.12345,-104.56789,1823.4,45.2,342,-87,12
```

- **Required:** `lat` (decimal degrees), `lon` (decimal degrees), `alt_m` (meters ASL)
- **Optional:** `speed_ms` (m/s ground speed), `heading_deg` (0–360°), `rssi` (dBm), `snr` (dB)
- One line per fix, `\n` terminated
- Parser also accepts standard NMEA `$GPGGA` sentences as a fallback (lat, lon, alt, fix quality, satellite count)

---

## Data Model

```ts
interface GpsPoint {
  lat: number;
  lon: number;
  alt_m: number;
  speed_ms?: number;
  heading_deg?: number;
  rssi?: number;
  t: number; // elapsed seconds from first fix
}
```

Points accumulate in `points: GpsPoint[]`. The array is never mutated in place — new array reference on each fix so React can schedule a render, but Leaflet map updates happen imperatively via refs to avoid full re-renders.

---

## UI Layout

### Connection Bar
- **Connect** button → `navigator.serial.requestPort()` dialog
- Baud rate `<select>` (options: 4800, 9600, 38400, 57600, 115200; default 115200)
- Status badge: `Disconnected` / `Connected — no fix` / `Live` (green pulse when fixes arriving)
- RSSI display (shown when present in data)

### Config Panel (collapsible)
- Launch site **Lat** / **Lon** text inputs — auto-populated from the first GPS fix if left blank, editable at any time
- **Waiver radius** in feet (converted to meters for `L.circle`)
- Unit toggle (ft/m) — defaults to app `unitSystem` prop

### Leaflet Map
Same tile stack as `TrajectoryMap`:
- ESRI World Imagery satellite base
- ESRI Reference/World_Boundaries_and_Places labels overlay

Map layers:
| Layer | Style |
|---|---|
| GPS track polyline | Altitude-colored (same blue→red gradient as simulation map), weight 3 |
| Current position marker | Rocket SVG icon rotated to `heading_deg`; falls back to circle if heading unknown |
| Launch point | Green `L.divIcon` circle, 12px |
| Waiver radius circle | Red dashed `L.circle`, same style as `TrajectoryMap` (`dashArray: '8 6'`, `fillOpacity: 0.06`) |
| Predicted landing dot | Amber pulsing `L.divIcon`, shown during descent only |

Map initializes centered on launch site coordinates. If no launch site is configured, it centers on the first GPS fix received.

### Stats Row (below map)
Six tiles in a grid:

`Current Alt` · `Max Alt` · `Speed` · `Heading` · `Fixes` · `Elapsed`

All values shown in the selected unit system.

### Action Buttons
- **Clear Track** — wipes `points[]`, removes polyline and resets map
- **Export CSV** — downloads all logged fixes as `gps_track_<timestamp>.csv` with headers `time_s,lat,lon,alt_m,speed_ms,heading_deg,rssi`

---

## Serial Read Loop

```
port = await navigator.serial.requestPort()
await port.open({ baudRate })
reader = port.readable.getReader()

while connected:
  { value, done } = await reader.read()
  append value to line buffer
  for each complete \n-terminated line:
    parse line → GpsPoint | null
    if valid: append to points[], update map imperatively
```

On disconnect (user clicks Disconnect or serial error): call `reader.cancel()`, `port.close()`.

### Parser Logic

```
if line.startsWith('$GPGGA'):
  parse NMEA $GPGGA → lat, lon, alt_m, fixQuality, satellites
  return null if fixQuality == 0 (no fix)
else:
  split by ','
  parse fields[0]=lat, [1]=lon, [2]=alt_m, [3]=speed_ms?, [4]=heading_deg?, [5]=rssi?, [6]=snr?
  return null if lat/lon/alt_m are not finite numbers
```

---

## Landing Prediction

Shown only during descent (altitude decreasing). Evaluated on every new fix after ≥ 4 fixes have accumulated.

```
descent detected: alt[n] < alt[n-3]  (3-fix lookback to filter noise)
descent_rate_ms = (alt[n] - alt[n-3]) / (t[n] - t[n-3])   // negative m/s
time_to_ground_s = alt[n] / abs(descent_rate_ms)
dx = speed_ms * sin(heading_rad) * time_to_ground_s
dy = speed_ms * cos(heading_rad) * time_to_ground_s
[pred_lat, pred_lon] = enuToLatLon(dx, dy, current_lat, current_lon)
```

Uses the same `enuToLatLon` helper already in `TrajectoryMap.tsx` (copy into `LiveTrackingTool.tsx` to keep the file self-contained).

If `speed_ms` or `heading_deg` are absent, predicted landing is skipped.

---

## Altitude Coloring

Same `altColor(frac)` function as `TrajectoryMap.tsx` — copied into `LiveTrackingTool.tsx` for self-containment. Track is drawn as colored polyline segments (one segment per new fix), with `frac = (alt - minAlt) / (maxAlt - minAlt)` computed from the accumulated point history.

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/tools/LiveTrackingTool.tsx` | **Create** — full tool implementation |
| `frontend/src/pages/ToolsPage.tsx` | **Modify** — add `'livetrack'` to `ToolId`, add tool def entry, mount `<LiveTrackingTool>` in panel |

No backend changes. No new npm dependencies.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Web Serial API not supported | Show inline warning: "Live tracking requires Chrome or Edge" |
| User denies port access | Status resets to Disconnected, no error thrown |
| Serial read error / device unplugged | Catch error, set status to Disconnected, preserve accumulated track |
| Unparseable line | Skip silently (no state change) |
| No fix (`$GPGGA` fixQuality = 0) | Skip point, status shows "Connected — no fix" |
