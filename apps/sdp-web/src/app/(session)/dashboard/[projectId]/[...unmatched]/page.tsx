import { notFound } from "next/navigation";

/**
 * Any address under a Project that no route matches. Without it Next renders the root 404,
 * outside the Project's layout, and the shell goes with it.
 */
export default function UnmatchedProjectPath(): never {
  notFound();
}
