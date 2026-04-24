import { useDropzone } from 'react-dropzone';

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
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/octet-stream': ['.ork'] },
    maxFiles: 1,
    disabled,
    onDropAccepted: (files) => {
      if (files[0]) onFileSelect(files[0]);
    },
  });

  const sizeKB = selectedFile
    ? (selectedFile.size / 1024).toFixed(1)
    : null;

  return (
    <div
      {...getRootProps()}
      className={[
        'rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors',
        isDragActive
          ? 'border-blue-400 bg-blue-950/30'
          : selectedFile
          ? 'border-green-600 bg-gray-900'
          : 'border-gray-600 bg-gray-900 hover:border-gray-400',
        disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : '',
      ].join(' ')}
    >
      <input {...getInputProps()} />

      {selectedFile ? (
        <div className="space-y-1">
          <p className="text-green-400 font-semibold text-lg">
            ✓ Ready
          </p>
          <p className="text-white font-medium">{selectedFile.name}</p>
          <p className="text-gray-400 text-sm">{sizeKB} KB</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-2xl">🚀</p>
          <p className="text-gray-300 font-medium">
            {isDragActive
              ? 'Drop it here...'
              : 'Drop your .ork file here or click to browse'}
          </p>
          <p className="text-gray-500 text-sm">OpenRocket .ork files only</p>
        </div>
      )}
    </div>
  );
}
