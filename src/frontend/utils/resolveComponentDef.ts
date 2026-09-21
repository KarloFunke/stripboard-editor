import { Component, ComponentDef } from "@/types";

// One resolved def per component object, so callers that key on the def (or
// memoise on it) see a stable identity for as long as the component and its
// base definition are unchanged.
const resolved = new WeakMap<Component, { base: ComponentDef; def: ComponentDef }>();

/**
 * Resolve the effective ComponentDef for a component instance: the base def,
 * with the component's footprint override merged in if it has one, and with
 * the value and package that decide how big its real body is.
 * A component with none of these gets the base def as-is.
 */
export function resolveComponentDef(
  component: Component,
  componentDefs: ComponentDef[]
): ComponentDef | undefined {
  const baseDef = componentDefs.find((d) => d.id === component.defId);
  if (!baseDef) return undefined;

  const override = component.footprintOverride;
  if (!override && !component.value && !component.package) return baseDef;

  const hit = resolved.get(component);
  if (hit && hit.base === baseDef) return hit.def;

  const def: ComponentDef = {
    ...baseDef,
    ...(override
      ? { width: override.width, height: override.height, pins: override.pins, bodyCells: override.bodyCells }
      : {}),
    part: { value: component.value, package: component.package },
  };
  resolved.set(component, { base: baseDef, def });
  return def;
}
