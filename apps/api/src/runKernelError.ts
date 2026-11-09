/** Shared error identity without importing the run kernel's dependency graph. */
export class RunKernelError extends Error {
  constructor(public readonly status:number,public readonly code:string,message:string){super(message);}
}
