'use client';

// useUnsavedGuard —— 编辑器离开保护 hook。
//
// 拦截三种离开场景：
//   1. 浏览器关闭 / 刷新 / 关闭标签页 → beforeunload
//   2. 任意 <a> 标签触发的同窗口导航（Next.js <Link>、普通 a.href）
//   3. 浏览器后退，以及编辑器内编程式 router.push / router.replace / router.back
//
// 用法：
//   const { guardedRouter, allowNext, confirmDialog } = useUnsavedGuard(isDirty);
//   onClick={guardedRouter.back}
//   handleSave 后立即调用 allowNext() 再 router.replace —— 让 setSavedSnapshot
//   触发的重渲染到来之前，本次 history 变更不会被拦下。
//
// 实现要点：
//   - click 拦截走 document.addEventListener('click', capture)，用 closest('a[href]')
//     找到触发的链接，再决定是否拦截；
//   - popstate 先把浏览器后退恢复到当前页，再由确认框决定是否真正离开；
//   - 不改写 history.pushState/replaceState，避免影响 Next.js 的其它页面导航。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface UnsavedGuardApi {
  /** 包了守卫的 router —— 编辑器 header 用这套替换原生 router。 */
  guardedRouter: {
    back: () => void;
    push: (href: string) => void;
    replace: (href: string) => void;
  };
  /**
   * 标记下一次 history 变更跳过守卫（用于「先保存再走」流程）。
   * 调用后必须立刻触发一次 pushState / replaceState（如 router.replace）。
   */
  allowNext: () => void;
  /** 直接渲染 confirmDialog 即可，hook 内部维护 open 状态 */
  confirmDialog: React.ReactNode;
}

export function useUnsavedGuard(isDirty: boolean, message?: string): UnsavedGuardApi {
  const router = useRouter();
  const [pending, setPending] = useState<
    | { kind: 'href'; href: string }
    | { kind: 'back' }
    | null
  >(null);
  const allowNextRef = useRef(false);
  const allowPopRef = useRef(false);

  // 浏览器关闭 / 刷新 —— 标准 beforeunload 协议。
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // 现代浏览器忽略自定义 message，但 e.preventDefault() 仍会弹原生确认。
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // 拦截 <a> 点击 —— 任意指向同窗口不同 href 的 <a> 都会触发守卫。
  // 用 capture 阶段，否则 Radix / Link 的内部 onClick 先 stopPropagation 会拦不到。
  useEffect(() => {
    if (!isDirty) return;
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; // 仅左键
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 新标签保留

      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;

      // target=_blank / download / mailto 放行
      const targetAttr = anchor.getAttribute('target');
      if (targetAttr && targetAttr !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;

      // hash 变化（同路由 hash 锚点）不算离开
      if (
        url.pathname === window.location.pathname
        && url.search === window.location.search
      ) return;

      e.preventDefault();
      e.stopPropagation();
      setPending({ kind: 'href', href: url.pathname + url.search });
    }
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, [isDirty]);

  // 浏览器原生后退不会触发 Link 点击。先同步回到当前 history entry，
  // 保留编辑器，再让用户在确认框中决定是否回退。
  useEffect(() => {
    if (!isDirty) return;
    function onPopState() {
      if (allowPopRef.current) {
        allowPopRef.current = false;
        return;
      }
      setPending({ kind: 'back' });
      window.history.go(1);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isDirty]);

  const guardedBack = useCallback(() => {
    if (!isDirty) {
      router.back();
      return;
    }
    setPending({ kind: 'back' });
  }, [isDirty, router]);

  const guardedPush = useCallback(
    (href: string) => {
      if (!isDirty || allowNextRef.current) {
        allowNextRef.current = false;
        router.push(href);
        return;
      }
      setPending({ kind: 'href', href });
    },
    [isDirty, router],
  );

  const guardedReplace = useCallback(
    (href: string) => {
      if (!isDirty || allowNextRef.current) {
        allowNextRef.current = false;
        router.replace(href);
        return;
      }
      setPending({ kind: 'href', href });
    },
    [isDirty, router],
  );

  const allowNext = useCallback(() => {
    allowNextRef.current = true;
  }, []);

  const handleConfirm = useCallback(() => {
    if (!pending) return;
    // 放行：让原生导航重做
    allowNextRef.current = true;
    if (pending.kind === 'href') {
      window.location.href = pending.href;
    } else {
      allowPopRef.current = true;
      window.history.go(-1);
    }
    setPending(null);
  }, [pending]);

  const handleStay = useCallback(() => {
    setPending(null);
  }, []);

  const isOpen = pending !== null;

  const confirmDialog = (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleStay();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>离开当前页面？</DialogTitle>
          <DialogDescription>
            {message ?? '当前有尚未保存的修改，离开后这些修改会丢失。'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleStay}>
            留在页面
          </Button>
          <Button type="button" variant="destructive" onClick={handleConfirm}>
            放弃修改并离开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return {
    guardedRouter: { back: guardedBack, push: guardedPush, replace: guardedReplace },
    allowNext,
    confirmDialog,
  };
}
