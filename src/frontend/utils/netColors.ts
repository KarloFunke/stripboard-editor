import { Net } from "@/types";

export const AUTO_NET_COLORS = [
  "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899",
  "#06b6d4", "#f97316", "#eab308", "#14b8a6",
  "#f43f5e", "#6366f1", "#84cc16", "#a855f7",
];

export function randomNetColor(existingNets: Net[]): string {
  const usedColors = new Set(existingNets.map((n) => n.color));
  const available = AUTO_NET_COLORS.filter((c) => !usedColors.has(c));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 50%)`;
}

export function nextNetName(nets: Net[]): string {
  let num = 1;
  while (nets.some((n) => n.name === `net${num}`)) num++;
  return `net${num}`;
}
