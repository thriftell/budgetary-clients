// Single source of truth for scenario presentation, shared by the chart markers
// and the legend so they can never drift. Every scenario carries a color AND a
// non-color channel (marker SHAPE) AND a human label — so a color-vision-
// deficient viewer can still tell scenarios apart. `out_of_domain` is included
// (it was previously missing from both the color map and the legend).

export type MarkerShape = "circle" | "square" | "triangle" | "diamond";

export interface ScenarioStyle {
  color: string;
  shape: MarkerShape;
  label: string;
}

export const SCENARIO_STYLES: Record<string, ScenarioStyle> = {
  confident: { color: "var(--vscode-charts-blue)", shape: "circle", label: "confident" },
  uncertain: { color: "var(--vscode-charts-yellow)", shape: "triangle", label: "uncertain" },
  sparse_evidence: { color: "var(--vscode-charts-orange)", shape: "square", label: "sparse evidence" },
  out_of_domain: { color: "var(--vscode-charts-purple)", shape: "diamond", label: "out of domain" },
};

export const UNKNOWN_STYLE: ScenarioStyle = {
  color: "var(--vscode-foreground)",
  shape: "circle",
  label: "other",
};

/**
 * Look up a scenario's style as an OWN property only, so an inherited key
 * ("constructor", "toString", "__proto__") can never resolve to a function or
 * object and inject markup into a fill attribute.
 */
export function styleForScenario(scenario: string): ScenarioStyle {
  return Object.hasOwn(SCENARIO_STYLES, scenario)
    ? SCENARIO_STYLES[scenario]!
    : UNKNOWN_STYLE;
}

/**
 * Human-readable scenario label: the known set's friendly wording, or the raw
 * value with underscores turned to spaces (so an unrecognized label is still
 * shown, never hidden as "other").
 */
export function scenarioLabel(scenario: string): string {
  return Object.hasOwn(SCENARIO_STYLES, scenario)
    ? SCENARIO_STYLES[scenario]!.label
    : scenario.replace(/_/g, " ");
}

/**
 * An SVG marker of the given shape centered at the origin — for use inside a
 * `<g transform="translate(cx cy)">`. `r` is the half-size. Coordinates are
 * fixed literals, never user data.
 */
export function markerShapeSvg(
  shape: MarkerShape,
  r: number,
  fill: string,
  opacity: number,
): string {
  const attrs = `fill="${fill}" opacity="${opacity}"`;
  switch (shape) {
    case "square":
      return `<rect x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" ${attrs}/>`;
    case "triangle":
      return `<polygon points="0,${-r} ${-r},${r} ${r},${r}" ${attrs}/>`;
    case "diamond":
      return `<polygon points="0,${-r} ${r},0 0,${r} ${-r},0" ${attrs}/>`;
    // biome-ignore lint/complexity/noUselessSwitchCase: the explicit "circle" case documents it as a first-class MarkerShape, not merely the default fallback.
    case "circle":
    default:
      return `<circle r="${r}" ${attrs}/>`;
  }
}

/** A 14×14 inline legend swatch matching a scenario's chart shape + color. */
export function legendSwatchSvg(style: ScenarioStyle): string {
  return `<svg class="b-legend-mark" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">${markerShapeSvg(
    style.shape,
    5,
    style.color,
    0.9,
  )}</svg>`;
}

/** The scenarios shown in the legend, in order (known set + the "other" bucket). */
export const LEGEND_STYLES: readonly ScenarioStyle[] = [
  SCENARIO_STYLES.confident!,
  SCENARIO_STYLES.uncertain!,
  SCENARIO_STYLES.sparse_evidence!,
  SCENARIO_STYLES.out_of_domain!,
  UNKNOWN_STYLE,
];
