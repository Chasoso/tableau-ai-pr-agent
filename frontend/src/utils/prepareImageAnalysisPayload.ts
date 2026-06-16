const DEFAULT_MAX_SIZE_BYTES = 1_500_000;
const DEFAULT_MAX_DIMENSION = 1600;
const DEFAULT_QUALITY = 0.82;

export type ImageAnalysisPayload = {
  originalDataUrl: string;
  analysisDataUrl: string;
  wasCompressed: boolean;
  compressionLabel: string;
  width: number;
  height: number;
  byteLength: number;
};

export async function prepareImageAnalysisPayload(
  file: File,
): Promise<ImageAnalysisPayload> {
  const image = await loadImage(file);

  if (!shouldCompress(file)) {
    const originalDataUrl = await readAsDataUrl(file);
    return {
      originalDataUrl,
      analysisDataUrl: originalDataUrl,
      wasCompressed: false,
      compressionLabel: "image ready for analysis",
      width: image.width,
      height: image.height,
      byteLength: file.size,
    };
  }

  const { width, height } = scaleToFit(
    image.width,
    image.height,
    DEFAULT_MAX_DIMENSION,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    const originalDataUrl = await readAsDataUrl(file);
    return {
      originalDataUrl,
      analysisDataUrl: originalDataUrl,
      wasCompressed: false,
      compressionLabel: "image ready for analysis",
      width: image.width,
      height: image.height,
      byteLength: file.size,
    };
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", DEFAULT_QUALITY);
  return {
    originalDataUrl: await readAsDataUrl(file),
    analysisDataUrl: dataUrl,
    wasCompressed: true,
    compressionLabel: `compressed for analysis (${width}x${height})`,
    width,
    height,
    byteLength: file.size,
  };
}

function shouldCompress(file: File): boolean {
  return file.size > DEFAULT_MAX_SIZE_BYTES;
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to decode image."));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function scaleToFit(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const largest = Math.max(width, height);
  if (largest <= maxDimension) {
    return { width, height };
  }

  const ratio = maxDimension / largest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function readAsDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Unable to read image data."));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Unable to read image data."));
    };
    reader.readAsDataURL(file);
  });
}
