import { CUP_HEIGHT, CUP_WIDTH, MAX_UPLOAD_BYTES } from '@/config/heytea';

export type ToneMode = 'binary' | 'grayscale' | 'original' | 'halftone' | 'sharp-binary';

export interface RenderOptions {
  toneMode: ToneMode;
  threshold?: number;
  fit: 'contain' | 'cover';
  maxBytes?: number;
  targetFormat?: 'png' | 'auto';
}

export async function readFileAsImage(file: File): Promise<HTMLImageElement> {
  const dataUrl = await fileToDataUrl(file);
  return loadImage(dataUrl);
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

export async function renderToCupCanvas(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  options: RenderOptions
): Promise<Blob> {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('当前浏览器不支持 Canvas');
  }

  canvas.width = CUP_WIDTH;
  canvas.height = CUP_HEIGHT;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scale =
    options.fit === 'cover'
      ? Math.max(CUP_WIDTH / image.width, CUP_HEIGHT / image.height)
      : Math.min(CUP_WIDTH / image.width, CUP_HEIGHT / image.height);

  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const offsetX = (CUP_WIDTH - drawWidth) / 2;
  const offsetY = (CUP_HEIGHT - drawHeight) / 2;

  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);

  const toneMode = options.toneMode ?? 'binary';
  if (toneMode !== 'original') {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    switch (toneMode) {
      case 'binary':
        applyBinaryThreshold(imageData, options.threshold);
        break;
      case 'grayscale':
        applyGrayscale(imageData);
        break;
      case 'halftone':
        applyHalftoneDots(imageData);
        break;
      case 'sharp-binary':
        applySharpBinary(imageData, options.threshold);
        break;
      default:
        applyBinaryThreshold(imageData, options.threshold);
        break;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  const baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  if (options.targetFormat === 'png') {
    const result = await exportPngWithQuantization(ctx, baseImageData, maxBytes);
    if (result) {
      return result;
    }
    throw new Error(`PNG 压缩后仍超过 ${Math.round(maxBytes / 1024)}KB`);
  }

  return exportWithCompression(canvas, maxBytes);
}

async function exportWithCompression(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  const attempts: Array<{ type: string; quality?: number }> = [
    { type: 'image/png' },
    { type: 'image/jpeg', quality: 0.95 },
    { type: 'image/jpeg', quality: 0.9 },
    { type: 'image/jpeg', quality: 0.85 },
    { type: 'image/jpeg', quality: 0.8 },
    { type: 'image/jpeg', quality: 0.75 },
    { type: 'image/jpeg', quality: 0.7 },
    { type: 'image/jpeg', quality: 0.65 },
    { type: 'image/jpeg', quality: 0.6 },
    { type: 'image/jpeg', quality: 0.55 },
    { type: 'image/jpeg', quality: 0.5 },
    { type: 'image/jpeg', quality: 0.45 },
    { type: 'image/jpeg', quality: 0.4 },
    { type: 'image/jpeg', quality: 0.35 },
    { type: 'image/jpeg', quality: 0.3 },
  ];

  let candidate: Blob | null = null;
  for (const attempt of attempts) {
    const blob = await canvasToBlob(canvas, attempt.type, attempt.quality);
    if (!blob) {
      continue;
    }
    candidate = blob;
    if (blob.size <= maxBytes) {
      return blob;
    }
  }

  if (!candidate) {
    throw new Error('无法导出图片');
  }

  return candidate;
}

async function exportPngWithQuantization(
  ctx: CanvasRenderingContext2D,
  baseImageData: ImageData,
  maxBytes: number
): Promise<Blob | null> {
  const steps = [0, 8, 16, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192];
  let fallback: Blob | null = null;

  for (const step of steps) {
    const working = new ImageData(
      new Uint8ClampedArray(baseImageData.data),
      baseImageData.width,
      baseImageData.height
    );

    if (step > 0) {
      quantizeColors(working.data, step);
    }

    ctx.putImageData(working, 0, 0);

    const blob = await canvasToBlob(ctx.canvas, 'image/png');
    if (!blob) {
      continue;
    }
    fallback = blob;
    if (blob.size <= maxBytes) {
      return blob;
    }
  }

  return fallback && fallback.size <= maxBytes ? fallback : null;
}

function quantizeColors(data: Uint8ClampedArray, step: number) {
  const divisor = step <= 0 ? 1 : step;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, Math.round(data[i] / divisor) * divisor);
    data[i + 1] = Math.min(255, Math.round(data[i + 1] / divisor) * divisor);
    data[i + 2] = Math.min(255, Math.round(data[i + 2] / divisor) * divisor);
  }
}

// 简化版网格半调点点：把图像划分为 cellSize×cellSize 的网格，
// 计算每个网格的平均亮度，用暗度映射成圆点半径再绘制。
// 参数选择偏向 dome.html 中较细腻的点阵效果。
export function applyHalftoneDots(imageData: ImageData, cellSize = 4) {
  const { width, height, data } = imageData;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 先填充略偏灰的底色，避免全白时点阵反差过强
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, width, height);

  // 预先算一份灰度数组，方便快速取平均
  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const g = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      gray[y * width + x] = g;
    }
  }

  const maxRadius = (cellSize * 0.75) / 2;

  ctx.fillStyle = '#000000';
  for (let cy = 0; cy < height; cy += cellSize) {
    for (let cx = 0; cx < width; cx += cellSize) {
      let sum = 0;
      let count = 0;
      const yEnd = Math.min(height, cy + cellSize);
      const xEnd = Math.min(width, cx + cellSize);
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          sum += gray[y * width + x];
          count++;
        }
      }
      if (!count) continue;
      const avg = sum / count; // 0..255，越大越亮
      // 使用稍微压缩高亮、拉伸中间灰度的曲线，让中间调也有明显点阵
      const norm = 1 - avg / 255; // 0..1，越大越暗
      const darkness = Math.pow(norm, 0.8); // 略增强暗部、中间调
      if (darkness <= 0) continue;

      const radius = Math.sqrt(darkness) * maxRadius;
      if (radius < 0.3) continue;

      const centerX = cx + (xEnd - cx) / 2;
      const centerY = cy + (yEnd - cy) / 2;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 把绘制结果写回 imageData
  const out = ctx.getImageData(0, 0, width, height);
  const outData = out.data;
  for (let i = 0; i < data.length; i++) {
    data[i] = outData[i];
  }
}

// "黑白平均（清晰算法）"：使用 Floyd-Steinberg 误差扩散实现的黑白抖动，
// 视觉上接近 dome.html 中的 FS 模式，比普通二值化细节更多、边缘更自然。
export function applySharpBinary(imageData: ImageData, threshold = 170) {
  const { width, height, data } = imageData;

  // 先生成灰度缓冲，便于做误差扩散
  const grayBuf = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const g = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      grayBuf[y * width + x] = g;
    }
  }

  const limit = Math.max(0, Math.min(255, Math.round(threshold)));

  // Floyd-Steinberg 误差扩散：左到右、上到下扫描
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const oldVal = grayBuf[p];
      const newVal = oldVal >= limit ? 255 : 0;
      const err = oldVal - newVal; // 误差（灰度差）
      grayBuf[p] = newVal;

      // 将误差分配给周围像素
      //       x   7/16
      // 3/16  5/16 1/16
      const distribute = (nx: number, ny: number, weight: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        grayBuf[ny * width + nx] += err * (weight / 16);
      };

      distribute(x + 1, y, 7);     // 右
      distribute(x - 1, y + 1, 3); // 左下
      distribute(x, y + 1, 5);     // 下
      distribute(x + 1, y + 1, 1); // 右下
    }
  }

  // 写回到 imageData（0 / 255 黑白）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = grayBuf[y * width + x] >= 128 ? 255 : 0;
      const idx = (y * width + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
}

function applyGrayscale(imageData: ImageData) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
}

function applyBinaryThreshold(imageData: ImageData, threshold = 170) {
  const limit = Math.max(0, Math.min(255, Math.round(threshold)));
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const value = gray >= limit ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob);
      },
      type,
      quality
    );
  });
}
