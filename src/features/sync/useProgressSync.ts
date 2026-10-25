import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { SaveData } from '../../types';
import { ProgressSyncController } from './controller';

interface Options { save: SaveData; setSave: Dispatch<SetStateAction<SaveData>>; userId: string | null | undefined; canApply: boolean; onBeforeApply?: () => void }

export function useProgressSync({ save, setSave, userId, canApply, onBeforeApply }: Options) {
  const [state, setState] = useState({ status: '保存在此浏览器', storageError: '' });
  const callbacks = useRef({ setSave, onBeforeApply });
  callbacks.current = { setSave, onBeforeApply };
  const ref = useRef<ProgressSyncController | null>(null);
  if (!ref.current) ref.current = new ProgressSyncController({ initialSave: save, onSave: next => callbacks.current.setSave(next), onBeforeApply: () => callbacks.current.onBeforeApply?.(), onState: setState });
  const controller = ref.current;
  useEffect(() => {
    controller.start();
    const online = () => controller.retry();
    const pageHide = () => controller.pageHide();
    window.addEventListener('online', online);
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', pageHide);
      controller.stop();
    };
  }, [controller]);
  useEffect(() => { controller.update(save, userId, canApply); }, [controller, save, userId, canApply]);
  return { ...state, retry: controller.retry, flush: controller.flush, prepareLogout: controller.prepareLogout };
}
