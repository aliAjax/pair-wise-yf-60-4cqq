/// <reference types="vite/client" />

// vinxi 0.5.11 的 package.json exports 把 "./client" 指向未发布的
// dist/types/runtime/client.d.ts，等价的类型声明实际位于 vinxi/types/client.d.ts。
// 这里在项目内提供相同的 ambient 声明，使 tsc --noEmit 可以通过。
declare interface Window {
  MANIFEST: {
    readonly [key: string]: unknown;
  };
  manifest: unknown;
}

interface ImportMetaEnv {
  readonly MANIFEST: {
    readonly [key: string]: unknown;
  };
}
