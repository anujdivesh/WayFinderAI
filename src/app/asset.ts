// URL of a file in public/, under the app's base path (basePath in next.config.ts).
// Next adds the base path to its own links and assets, but not to these.
export const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
