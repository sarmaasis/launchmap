import { useEffect, useState } from "react";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import AppHome from "./pages/AppHome";
import PublicLaunch from "./pages/PublicLaunch";
import Success from "./pages/Success";

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  if (path === "/login") return <Login />;
  if (path === "/app") return <AppHome />;
  if (path === "/checkout/success") return <Success />;
  if (path.startsWith("/l/")) return <PublicLaunch slug={decodeURIComponent(path.slice(3))} />;
  return <Landing />;
}
