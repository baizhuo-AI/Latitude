import { useMemo } from "react";
import { BrowserLiveDimensionApp } from "./projections/desktop/BrowserLiveDimensionApp";
import { HttpDesktopRuntime } from "./runtime/host/HttpDesktopRuntime";
import { desktopFetch } from "./dimension/pet/nativePet";
import { NativePetChat, NativePetNotice, NativePetWindow } from "./dimension/pet/PetWindows";
import { ErrorBoundary } from "./components/ErrorBoundary";

export default function NativeDesktopApp() {
  const runtime = useMemo(() => new HttpDesktopRuntime({ fetchImpl: desktopFetch }), []);
  const role = location.hash;
  const floating = role === "#/__pet__" || role === "#/__pet_chat__" || role === "#/__pet_notice__";
  if (floating) document.documentElement.dataset.petWindow = "true";
  return <ErrorBoundary>
    {role === "#/__pet__" ? <NativePetWindow /> : role === "#/__pet_chat__" ? <NativePetChat />
      : role === "#/__pet_notice__" ? <NativePetNotice /> : <BrowserLiveDimensionApp runtime={runtime} />}
  </ErrorBoundary>;
}
