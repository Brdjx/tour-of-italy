// The band at the very top of the page, in the flag's colours: green, white and red in equal
// thirds, 4 px tall, under the status bar in the installed app. It draws in once from the left
// as the page opens (tricolore.css) and stays with the page on both screens. Decorative, so it
// is hidden from assistive technology.

export function TricoloreBand() {
  return (
    <div className="tricolore" aria-hidden="true" data-testid="tricolore">
      <span className="tricolore-green" />
      <span className="tricolore-white" />
      <span className="tricolore-red" />
    </div>
  );
}
