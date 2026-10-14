// 写真を長い辺1600pxのJPEGに縮める（一覧用に長い辺320pxの小さい画像も作る）

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('写真を読みこめませんでした')); };
    img.src = url;
  });
}

function toBlob(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve({ blob: b, w, h }) : reject(new Error('写真を保存できませんでした'))), 'image/jpeg', quality);
  });
}

export async function shrinkPhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const big = await toBlob(img, 1600, 0.85);
    const small = await toBlob(img, 320, 0.75);
    return { blob: big.blob, thumb: small.blob, width: big.w, height: big.h };
  } finally {
    URL.revokeObjectURL(url);
  }
}
