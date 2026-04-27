interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const steps = [
  {
    num: '1',
    title: 'Export from OpenRocket',
    body: 'Save your design as a .ork file from OpenRocket (File → Save As). The file contains your rocket geometry, motor, and parachute configuration.',
  },
  {
    num: '2',
    title: 'Upload & configure launch',
    body: 'Drop the .ork file into the upload area. Set your launch site coordinates, elevation, rail length, inclination, and heading. Toggle imperial/metric to match your preference.',
  },
  {
    num: '3',
    title: 'Optionally add live weather',
    body: 'Enable "Use live weather" to pull real NOMADS GFS forecast data for your launch site and date. GFS runs every 6 hours — pick the time closest to your launch window. Without live weather, a standard atmosphere (no wind) is used.',
  },
  {
    num: '4',
    title: 'Run the simulation',
    body: 'Click "Run Simulation". RocketBridge runs OpenRocket and RocketPy simultaneously (15–30 s). Results include apogee, max velocity, max Mach, stability margins, and full time-series data.',
  },
  {
    num: '5',
    title: 'Review results',
    body: 'The comparison table shows both simulators side by side with percent deltas highlighted green (<5%), yellow (<15%), or red (>15%). Charts show altitude, velocity, Mach, stability, and thrust over time.',
  },
  {
    num: '6',
    title: '3D trajectory & orientation',
    body: 'The 3D trajectory plot shows the full flight path including parachute drift (drift is only non-zero with live weather enabled). The orientation panel animates the rocket\'s attitude through flight. Press Play on either, or drag the time slider.',
  },
  {
    num: '7',
    title: 'Map overlay & KML',
    body: 'The map panel overlays the trajectory on satellite imagery centered on your launch site. Colors shift from blue (low altitude) to red (apogee). Click "Download KML" to open the full 3D trajectory in Google Earth Pro.',
  },
  {
    num: '8',
    title: 'Rocket Details',
    body: 'Click "Rocket Details" in the header to review extracted rocket parameters: motor designation, dimensions, mass breakdown, fin count, and parachute count — useful for double-checking the conversion from OpenRocket.',
  },
];

export function HowToModal({ isOpen, onClose }: Props) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white">How to use RocketBridge</h2>
            <p className="text-xs text-gray-500 mt-0.5">OpenRocket .ork file → RocketPy simulation in minutes</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-800"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Steps */}
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {steps.map((s) => (
            <div key={s.num} className="flex gap-4">
              <div className="shrink-0 w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/40 flex items-center justify-center">
                <span className="text-xs font-bold text-blue-400">{s.num}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-200">{s.title}</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{s.body}</p>
              </div>
            </div>
          ))}

          <div className="mt-2 pt-4 border-t border-gray-800">
            <p className="text-xs text-gray-600">
              RocketBridge uses{' '}
              <span className="text-gray-500">RocketPy</span> for 6-DOF simulation and{' '}
              <span className="text-gray-500">OpenRocket 23.09</span> via orhelper for baseline comparison.
              Wind drift during parachute descent requires live weather to be enabled.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
