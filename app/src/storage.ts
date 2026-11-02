import AsyncStorage from '@react-native-async-storage/async-storage';

// Всё хранится только на устройстве: город, язык, просмотренные и понравившиеся вакансии
export async function read<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function write(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Нет хранилища (приватный режим): приложение работает, просто не помнит
  }
}
