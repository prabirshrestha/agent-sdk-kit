// intentional type error: number assigned to string
const x: string = 42;

// intentional lint error: no-unused-vars
const unused = "hello";

// intentional format error: bad formatting
export function bad(a: string, b: number) {
  return a + b;
}
