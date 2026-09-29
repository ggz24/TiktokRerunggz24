export const maxVideoBytes = 8 * 1024 * 1024 * 1024;
export const maxLibraryBytes = 40 * 1024 * 1024 * 1024;
export const maxLibraryVideos = 100;

export type StoredVideo = {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
};

export function uploadMp4(file: File, onProgress: (percent: number) => void): Promise<StoredVideo> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/live/videos');
    request.setRequestHeader('Content-Type', 'video/mp4');
    request.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    request.onerror = () => reject(new Error('เชื่อมต่อระบบอัปโหลดไม่ได้ กรุณาลองอีกครั้ง'));
    request.onload = () => {
      if (request.status === 413) {
        reject(new Error('ไฟล์ใหญ่เกิน 8 GB หรือพื้นที่คลัง 40 GB เต็ม'));
        return;
      }
      if (request.status !== 201) {
        reject(new Error('อัปโหลดวิดีโอไม่สำเร็จ กรุณาลองอีกครั้ง'));
        return;
      }
      try {
        const result: unknown = JSON.parse(request.responseText);
        if (!result || typeof result !== 'object' || !('item' in result) || !result.item) {
          throw new Error('Invalid upload response');
        }
        resolve(result.item as StoredVideo);
      } catch {
        reject(new Error('อ่านผลการอัปโหลดไม่สำเร็จ กรุณารีเฟรชคลังวิดีโอ'));
      }
    };
    request.send(file);
  });
}
