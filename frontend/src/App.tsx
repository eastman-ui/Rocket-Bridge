import { useState } from 'react';
import axios from 'axios';
import FileUpload from './components/FileUpload';
import LaunchConfigForm from './components/LaunchConfig';
import type { LaunchConfig } from './components/LaunchConfig';
import type { ComparisonResponse } from './types';

// ── Inline small components ──────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="flex items-center gap-4 bg-gray-900 rounded-xl p-5">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
      <p className="text-gray-300 text-sm">
        Running RocketPy simulation… this may take 15–30 seconds
      </p>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-red-950 border border-red-700 rounded-xl p-5">
      <p className="text-red-400 font-semibold mb-1">Simulation failed</p>
      <p className="text-red-300 text-sm font-mono break-all">{message}</p>
    </div>
  );
}

// ── Default config ───────────────────────────────────────────────────────────

const defaultConfig: LaunchConfig = {
  lat: 32.99,
  lon: -106.97,
  elevation: 1400,
  railLength: 5.2,
  inclination: 85,
  heading: 0,
  useLiveWeather: false,
};

// ── App ──────────────────────────────────────────────────────────────────────

type AppState = 'idle' | 'simulating' | 'results' | 'error';

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [config, setConfig] = useState<LaunchConfig>(defaultConfig);
  const [results, setResults] = useState<ComparisonResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSimulate = async () => {
    if (!selectedFile) return;
    setAppState('simulating');
    setErrorMessage('');
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      const params = new URLSearchParams({
        lat: config.lat.toString(),
        lon: config.lon.toString(),
        elevation: config.elevation.toString(),
        rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(),
        heading: config.heading.toString(),
        use_live_weather: config.useLiveWeather.toString(),
      });
      const response = await axios.post<ComparisonResponse>(
        `/api/simulate?${params}`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      setResults(response.data);
      setAppState('results');
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.detail ?? err.message)
        : String(err);
      setErrorMessage(msg);
      setAppState('error');
    }
  };

  const isSimulating = appState === 'simulating';

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-5">
        <h1 className="text-2xl font-bold tracking-tight">🚀 RocketBridge</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          OpenRocket → RocketPy comparison tool
        </p>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <FileUpload
          onFileSelect={setSelectedFile}
          selectedFile={selectedFile}
          disabled={isSimulating}
        />

        <LaunchConfigForm
          config={config}
          onChange={setConfig}
          disabled={isSimulating}
        />

        <button
          onClick={handleSimulate}
          disabled={!selectedFile || isSimulating}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition-colors"
        >
          {isSimulating ? '⏳ Running simulation…' : 'Run Simulation'}
        </button>

        {appState === 'simulating' && <LoadingSpinner />}
        {appState === 'error' && <ErrorBox message={errorMessage} />}
        {appState === 'results' && results && (
          <div className="space-y-6">
            <div
              id="comparison-table-placeholder"
              className="bg-gray-900 rounded-xl p-4 text-gray-400"
            >
              Comparison table loading…
            </div>
            <div
              id="charts-placeholder"
              className="bg-gray-900 rounded-xl p-4 text-gray-400"
            >
              Charts loading…
            </div>
            <div
              id="trajectory-placeholder"
              className="bg-gray-900 rounded-xl p-4 text-gray-400"
            >
              3D trajectory loading…
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
