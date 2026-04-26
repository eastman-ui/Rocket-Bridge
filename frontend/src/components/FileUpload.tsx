import { useState } from 'react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  selectedFile: File | null;
  disabled: boolean;
}

export default function FileUpload({
  onFileSelect,
  selectedFile,
  disabled,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const accept = (file: File | undefined) => {
    if (file?.name.endsWith('.ork')) onFileSelect(file);
  };

  return (
    <div
      className={[
        'relative rounded-xl border-2 border-dashed px-4 py-5 flex flex-col items-center justify-center text-center transition-colors',
        isDragging
          ? 'border-blue-400 bg-blue-950/30'
          : selectedFile
          ? 'border-green-600 bg-gray-900'
          : 'border-gray-600 bg-gray-900',
      ].join(' ')}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (!disabled) accept(e.dataTransfer.files[0]);
      }}
    >
      {/* Invisible file input overlaid on the entire area — user clicks it directly */}
      <input
        type="file"
        accept=".ork"
        disabled={disabled}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {selectedFile ? (
        <div className="space-y-1 pointer-events-none">
          <p className="text-green-400 font-semibold text-sm">File loaded</p>
          <p className="text-white text-sm font-medium truncate max-w-[220px]">{selectedFile.name}</p>
          <p className="text-gray-500 text-xs">{(selectedFile.size / 1024).toFixed(1)} KB</p>
        </div>
      ) : (
        <div className="space-y-1 pointer-events-none">
          <p className="text-gray-300 text-sm font-medium">
            {isDragging ? 'Drop here…' : 'Drop .ork or click'}
          </p>
          <p className="text-gray-600 text-xs">OpenRocket files only</p>
        </div>
      )}
    </div>
  );
}
