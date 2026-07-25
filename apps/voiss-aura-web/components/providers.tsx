"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type SessionState = {
  csrfToken: string;
  mode: "demo" | "local";
  correlationId: string;
};

const SessionContext = createContext<SessionState | null>(null);

export function useVoissSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) throw new Error("VOISS session is not ready.");
  return session;
}

export function Providers({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/session", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("session unavailable");
        return response.json() as Promise<SessionState>;
      })
      .then(setSession);
  }, []);

  const headers = useMemo<Record<string, string>>(() => {
    if (!session) return {} as Record<string, string>;
    return {
      "x-voiss-csrf": session.csrfToken,
      "x-correlation-id": session.correlationId,
    };
  }, [session]);

  if (!session) {
    return (
      <p className="boot-status" role="status">
        正在建立本機安全工作階段…
      </p>
    );
  }

  return (
    <SessionContext.Provider value={session}>
      <CopilotKit
        runtimeUrl="/api/copilotkit"
        useSingleEndpoint={false}
        headers={headers}
        onError={({ type }) => setRuntimeError(type)}
        enableInspector={false}
      >
        {runtimeError ? (
          <p className="boot-status" role="alert">
            Agent runtime 暫時無法連線（{runtimeError}
            ）；工作台的證據檢視仍可使用，重新整理即可重試。
          </p>
        ) : null}
        {children}
      </CopilotKit>
    </SessionContext.Provider>
  );
}
