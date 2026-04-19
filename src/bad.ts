// intentional type error
const x: string = 42;

// intentional lint error (unused variable)
const unused = "this is never used";

// intentional format error (extra spaces, wrong quotes)
export function   badFormat(   a:string,b:number   ):    string {
  return    a +    b.toString(  );
}
