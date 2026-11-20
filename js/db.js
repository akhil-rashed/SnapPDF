/**
 * IndexedDB persistence for SnapPDF:
 * - Autosaves current project (pages + blobs + settings)
 * - Stores reusable signatures locally
 */
const DB_NAME = 'snappdf-db';
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('project')) {
        db.createObjectStore('project', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('signatures')) {
        db.createObjectStore('signatures', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(projectData) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('project', 'readwrite');
      tx.objectStore('project').put({
        id: 'current',
        updatedAt: Date.now(),
        ...projectData,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB save failed:', err);
  }
}

export async function loadProject() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('project', 'readonly');
      const req = tx.objectStore('project').get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearProject() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('project', 'readwrite');
      tx.objectStore('project').delete('current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

export async function saveSignature(sig) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('signatures', 'readwrite');
    tx.objectStore('signatures').put(sig);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSignatures() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('signatures', 'readonly');
      const req = tx.objectStore('signatures').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteSignature(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('signatures', 'readwrite');
    tx.objectStore('signatures').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
