import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "./components/useToast";
import { appVersion, ping } from "./lib/commands";
import { describeError } from "./lib/invoke";

function App() {
  const { show } = useToast();
  const [message, setMessage] = useState("hello");

  const version = useQuery({ queryKey: ["appVersion"], queryFn: appVersion });

  const pingCommand = useMutation({
    mutationFn: ping,
    onSuccess: (pong) => show(`Pong: ${pong.echo}`, "success"),
    onError: (error) => show(describeError(error), "error"),
  });

  return (
    <main className="flex h-full flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">DataLooker</h1>
      <p className="text-sm opacity-70">version {version.data ?? "…"}</p>

      <form
        className="join"
        onSubmit={(event) => {
          event.preventDefault();
          pingCommand.mutate(message);
        }}
      >
        <input
          className="input join-item"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          aria-label="Ping message"
        />
        <button type="submit" className="btn join-item" disabled={pingCommand.isPending}>
          Ping
        </button>
      </form>
    </main>
  );
}

export default App;
