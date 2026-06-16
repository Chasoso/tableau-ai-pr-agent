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
  const originalDataUrl = await readAsDataUrl(file);
  const width = image?.width ?? 1;
  const height = image?.height ?? 1;

  if (!shouldCompress(file)) {
    return {
      originalDataUrl,
      analysisDataUrl: originalDataUrl,
      wasCompressed: false,
      compressionLabel: "image ready for analysis",
      width,
      height,
      byteLength: file.size,
    };
  }

  const scaled = scaleToFit(width, height, DEFAULT_MAX_DIMENSION);
  const canvas = document.createElement("canvas");
  canvas.width = scaled.width;
  canvas.height = scaled.height;

  const context = canvas.getContext("2d");
  if (!context) {
    return {
      originalDataUrl,
      analysisDataUrl: originalDataUrl,
      wasCompressed: false,
      compressionLabel: "image ready for analysis",
      width,
      height,
      byteLength: file.size,
    };
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, scaled.width, scaled.height);
  if (image) {
    context.drawImage(image, 0, 0, scaled.width, scaled.height);
  }

  return {
    originalDataUrl,
    analysisDataUrl: canvas.toDataURL("image/jpeg", DEFAULT_QUALITY),
    wasCompressed: Boolean(image),
    compressionLabel: image
      ? `compressed for analysis (${scaled.width}x${scaled.height})`
      : "image ready for analysis",
    width: scaled.width,
    height: scaled.height,
    byteLength: file.size,
  };
}

function shouldCompress(file: File): boolean {
  return file.size > DEFAULT_MAX_SIZE_BYTES;
}

async function loadImage(file: File): Promise<HTMLImageElement | undefined> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement | undefined>((resolve) => {
      const image = new Image();
      const timeoutId = setTimeout(() => resolve(undefined), 250);
      image.onload = () => {
        clearTimeout(timeoutId);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timeoutId);
        resolve(undefined);
      };
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
