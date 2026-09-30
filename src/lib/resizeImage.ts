/** Shrink a phone photo to 720 px wide WebP (~50-100 KB) before uploading it. */
export async function resizeImage(file: File, width = 720): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, width / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.72));
  return blob ?? file;
}
