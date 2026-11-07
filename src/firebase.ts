import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase App
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore
// Use specified database ID if present in config, otherwise default
export const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

export interface SavedFanDuelData {
  salaries: Record<string, number>;
  uploadDate: string; // e.g., "Saturday, March 7, 2026, 6:04 PM"
  timestamp: number; // Unix timestamp ms
  matchedCount: number;
  unmatchedNames: string[];
}

const FD_SALARIES_COLLECTION = 'fanduel_salaries';
const FD_SALARIES_DOC_ID = 'latest';

/**
 * Saves uploaded FanDuel salaries to Firestore
 */
export async function saveFanDuelSalariesToCloud(data: SavedFanDuelData): Promise<void> {
  const docRef = doc(db, FD_SALARIES_COLLECTION, FD_SALARIES_DOC_ID);
  await setDoc(docRef, data);
}

/**
 * Fetches the latest FanDuel salaries from Firestore
 */
export async function getFanDuelSalariesFromCloud(): Promise<SavedFanDuelData | null> {
  try {
    const docRef = doc(db, FD_SALARIES_COLLECTION, FD_SALARIES_DOC_ID);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as SavedFanDuelData;
    }
  } catch (err) {
    console.warn('Failed to load FanDuel salaries from Firestore:', err);
  }
  return null;
}

/**
 * Subscribes to real-time updates for latest FanDuel salaries from Firestore
 */
export function subscribeToFanDuelSalaries(callback: (data: SavedFanDuelData | null) => void): () => void {
  try {
    const docRef = doc(db, FD_SALARIES_COLLECTION, FD_SALARIES_DOC_ID);
    return onSnapshot(
      docRef,
      (snap) => {
        if (snap.exists()) {
          callback(snap.data() as SavedFanDuelData);
        } else {
          callback(null);
        }
      },
      (err) => {
        console.warn('Firestore subscription warning:', err);
      }
    );
  } catch (err) {
    console.warn('Could not establish Firestore subscription:', err);
    return () => {};
  }
}
