import { Component, ComponentDef } from "@/types";

/**
 * Resolve the effective ComponentDef for a component instance.
 * If the component has a footprint override, merge it with the base def.
 * Otherwise, return the base def as-is.
 */
export function resolveComponentDef(
  component: Component,
  componentDefs: ComponentDef[]
): ComponentDef | undefined {
  const baseDef = componentDefs.find((d) => d.id === component.defId);
  if (!baseDef) return undefined;

  if (!component.footprintOverride) return baseDef;

  return {
    ...baseDef,
    width: component.footprintOverride.width,
    height: component.footprintOverride.height,
    pins: component.footprintOverride.pins,
    bodyCells: component.footprintOverride.bodyCells,
  };
}
