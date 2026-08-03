'use client';

// useUnsavedGuard —— 编辑器离开保护 hook。
//
// 拦截三种离开场景：
//   1. 浏览器关闭 / 刷新 / 关闭标签页 → beforeunload
//   2. 任意 <a> 标签触发的同窗口导航（Next.js <Link>、普通 a.href）
//   3. 编程式 router.push / router.replace / router.back（通过 guardedRouter）
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
//   - history.pushState/replaceState monkey-patch 拦截 router.replace（保存后跳转）。
//   - 「放弃修改并离开」会直接修改 location；「留在页面」关闭 dialog。

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

  // 拦截编程式 router 跳转：monkey-patch history.pushState/replaceState。
  // 编辑器主要在「保存成功后 router.replace 跳详情页」时使用这些接口。
  // dirty 状态下我们先拦下，弹 dialog 询问。
  // allowNext 给「先保存再走」的开一道临时门（调用一次即消费）。
  useEffect(() => {
    if (!isDirty) return;
    const originalPush = window.history.pushState.bind(window.history);
    const originalReplace = window.history.replaceState.bind(window.history);

    function patched(this: History, ..._args: Parameters<typeof originalPush>) {
      if (allowNextRef.current) {
        allowNextRef.current = false;
        return originalPush.apply(this, _args);
      }
      setPending({ kind: 'back' });
      // 拦截：什么都不做，等用户从 dialog 选「放弃并离开」再补一次跳转。
    }
    function patchedReplace(this: History, ..._args: Parameters<typeof originalReplace>) {
      if (allowNextRef.current) {
        allowNextRef.current = false;
        return originalReplace.apply(this, _args);
      }
      setPending({ kind: 'back' });
    }
    window.history.pushState = patched as typeof window.history.pushState;
    window.history.replaceState = patchedReplace as typeof window.history.replaceState;
    return () => {
      window.history.pushState = originalPush;
      window.history.replaceState = originalReplace;
    };
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
      if (!isDirty) {
        router.push(href);
        return;
      }
      setPending({ kind: 'href', href });
    },
    [isDirty, router],
  );

  const guardedReplace = useCallback(
    (href: string) => {
      if (!isDirty) {
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
