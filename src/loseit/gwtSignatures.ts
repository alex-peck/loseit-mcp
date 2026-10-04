/** Prefer the app's models and java.util types when short class names collide. */
export function preferGwtSignature(candidate: string, existing: string): boolean {
  const priority = (signature: string): number => {
    const name = signature.slice(0, signature.lastIndexOf("/")).replace(/^\[+L?/, "");
    if (name.startsWith("com.loseit.")) return 2;
    if (name.startsWith("java.util.")) return 1;
    return 0;
  };
  return priority(candidate) > priority(existing);
}
