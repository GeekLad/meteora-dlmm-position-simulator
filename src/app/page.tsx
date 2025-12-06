import { Suspense } from "react";
import { DlmmSimulator } from "@/components/dlmm-simulator";

export default function Home() {
  return (
    <main className="container mx-auto p-4 md:p-8">
      <Suspense fallback={<div>Loading...</div>}>
        <DlmmSimulator />
      </Suspense>
    </main>
  );
}
