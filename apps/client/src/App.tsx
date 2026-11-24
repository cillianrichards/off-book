// The application shell (P2-14): a header and the page the address asks for. The board, clocks and
// result arrive with P2-15 to P2-17.

import type { Route } from './route.ts';

export function App({ route }: { readonly route: Route }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <a className="brand" href="/">
          Off Book
        </a>
      </header>
      <main className="shell-main">
        <Page route={route} />
      </main>
    </div>
  );
}

function Page({ route }: { readonly route: Route }) {
  if (route.page === 'home')
    return (
      <section>
        <h1>Off Book</h1>
        <p>Chess from positions off the book. Open a challenge link to play.</p>
      </section>
    );
  if (route.page === 'game')
    return (
      <section>
        <h1>Game {route.id}</h1>
        <p className="muted">The board is not built yet.</p>
      </section>
    );
  return (
    <section>
      <h1>Not found</h1>
      <p>
        Nothing lives at this address. <a href="/">Go home</a>.
      </p>
    </section>
  );
}
