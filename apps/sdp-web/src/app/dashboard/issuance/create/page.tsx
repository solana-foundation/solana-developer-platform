import { Suspense } from "react";
import { IssuanceSimplifiedPrototype } from "../../../prototype/issuance-simplified/issuance-simplified-prototype";

export default async function CreateAssetPage() {
  return (
    <Suspense>
      <IssuanceSimplifiedPrototype embedded />
    </Suspense>
  );
}
