"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useProjectStore } from "@/store/useProjectStore";
import { track } from "@/lib/track";
import { SITE_URL } from "@/lib/site";
import PrintBoard from "./PrintBoard";
import { buildBOM } from "./bom";

function CalibrationRuler() {
  return (
    <div className="flex items-end gap-2">
      <div className="flex" style={{ width: "50mm", height: "6mm" }}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex-1 border-l border-b border-black first:border-l" />
        ))}
        <div className="border-r border-black" />
      </div>
      <span className="text-[10px] text-neutral-600">
        50&nbsp;mm - measure this. If it isn&apos;t exactly 50&nbsp;mm, reprint at 100% (no &quot;fit to page&quot;).
      </span>
    </div>
  );
}

export default function PrintPreview({ onClose, source, editUuid, viewUuid }: { onClose: () => void; source: "edit" | "view"; editUuid?: string; viewUuid?: string | null }) {
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const name = useProjectStore((s) => s.name);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [showComponentSheet, setShowComponentSheet] = useState(true);
  const [includeCutSheet, setIncludeCutSheet] = useState(true);
  const [showBom, setShowBom] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showWires, setShowWires] = useState(true);
  const [showCuts, setShowCuts] = useState(true);
  const [showPinLabels, setShowPinLabels] = useState(true);
  const [showViewQr, setShowViewQr] = useState(false);
  const [showEditQr, setShowEditQr] = useState(false);

  const viewUrl = viewUuid ? `${SITE_URL}/view/${viewUuid}?utm_source=print-qr-view&utm_medium=qr` : null;
  const editUrl = editUuid ? `${SITE_URL}/project/${editUuid}?utm_source=print-qr-edit&utm_medium=qr` : null;

  const bom = buildBOM(components, componentDefs);

  const toggle = (label: string, v: boolean, set: (b: boolean) => void) => (
    <label className="flex items-center gap-1.5 cursor-pointer select-none">
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)}
        className="cursor-pointer accent-[#113768]" />
      <span>{label}</span>
    </label>
  );

  const printNow = () => {
    track("print-pdf", {
      source,
      componentSheet: showComponentSheet ? "on" : "off",
      cutSheet: includeCutSheet ? "on" : "off",
      bom: showBom ? "on" : "off",
      refLabels: showLabels ? "on" : "off",
      wires: showWires ? "on" : "off",
      cuts: showCuts ? "on" : "off",
      pinLabels: showPinLabels ? "on" : "off",
      viewQr: showViewQr && viewUrl ? "on" : "off",
      editQr: showEditQr && editUrl ? "on" : "off",
    });
    const prevTitle = document.title;
    document.title = name.trim() ? `${name.trim()} - stripboard` : "Stripboard print";
    const restore = () => {
      document.title = prevTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };

  if (!mounted) return null;

  const nothingSelected = !showComponentSheet && !includeCutSheet && !showBom;

  return createPortal(
    <div className="print-portal">
    <div className="print-overlay fixed inset-0 z-50 flex flex-col bg-black/50">
      <div className="print-hide flex items-center gap-4 px-5 h-12 bg-[#113768] text-white text-sm">
        <span className="font-semibold">Print / PDF</span>
        <div className="flex items-center gap-x-4 gap-y-1 text-xs flex-wrap">
          {toggle("Component sheet", showComponentSheet, setShowComponentSheet)}
          {toggle("Cut sheet", includeCutSheet, setIncludeCutSheet)}
          {toggle("BOM", showBom, setShowBom)}
          <span className="opacity-40">|</span>
          {toggle("Ref labels", showLabels, setShowLabels)}
          {toggle("Wires", showWires, setShowWires)}
          {toggle("Cuts", showCuts, setShowCuts)}
          {toggle("Pin labels", showPinLabels, setShowPinLabels)}
          {(viewUrl || editUrl) && <span className="opacity-40">|</span>}
          {viewUrl && toggle("View QR", showViewQr, setShowViewQr)}
          {editUrl && toggle("Edit QR", showEditQr, setShowEditQr)}
          {showEditQr && editUrl && (
            <span className="text-red-400 font-bold text-sm">Warning: the Edit QR lets anyone who scans it edit this project</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={printNow}
            className="px-3.5 py-1.5 rounded bg-white/15 hover:bg-white/25 transition-colors">
            Print / Save as PDF
          </button>
          <button onClick={onClose}
            className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors">
            Close
          </button>
        </div>
      </div>

      <div className="print-scroll flex-1 overflow-auto bg-neutral-200 dark:bg-neutral-800 p-6">
        <div className="print-root mx-auto bg-white text-black" style={{ width: "210mm" }}>
          {showComponentSheet && (
          <div className="print-keep p-[10mm]">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <div className="text-base font-semibold">{name} | placement (component side)</div>
                <div className="text-[11px] text-neutral-600 mb-2">
                  Print at 100% / actual size, disable &quot;fit to page&quot;, then verify the ruler.
                  Lay this on the component side and push leads through the marked holes.
                </div>
                <CalibrationRuler />
              </div>
              {((showViewQr && viewUrl) || (showEditQr && editUrl)) && (
                <div className="flex items-start gap-4 flex-shrink-0">
                  {showViewQr && viewUrl && (
                    <div className="text-center">
                      <div style={{ width: "24mm", height: "24mm" }}>
                        <QRCodeSVG value={viewUrl} level="M" style={{ width: "100%", height: "100%" }} />
                      </div>
                      <a href={viewUrl} className="block text-[9px] mt-1 text-neutral-500 no-underline">Scan to view</a>
                    </div>
                  )}
                  {showEditQr && editUrl && (
                    <div className="text-center">
                      <div style={{ width: "24mm", height: "24mm" }}>
                        <QRCodeSVG value={editUrl} level="M" style={{ width: "100%", height: "100%" }} />
                      </div>
                      <a href={editUrl} className="block text-[9px] mt-1 text-neutral-500 no-underline">Scan to edit</a>
                    </div>
                  )}
                </div>
              )}
            </div>
            <PrintBoard variant="place" showLabels={showLabels} showWires={showWires} showCuts={showCuts} showPinLabels={showPinLabels} />
          </div>
          )}

          {includeCutSheet && (
            <div className="print-keep p-[10mm]">
              <div className="mb-3">
                <div className="text-base font-semibold">{name} | track cuts (copper side, mirrored)</div>
                <div className="text-[11px] text-neutral-600 mb-2">
                  Mirrored for the underside. Cut each ✕. Verify the ruler.
                </div>
                <CalibrationRuler />
              </div>
              <PrintBoard variant="cut" showLabels={showLabels} showWires={false} showCuts={true} showPinLabels={false} />
            </div>
          )}

          {showBom && (
          <div className="p-[10mm]">
            <div className="text-sm font-semibold mb-2">{name} | bill of materials</div>
            <table className="print-bom w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-black text-left">
                  <th className="py-0.5 pr-3 w-10">Qty</th>
                  <th className="py-0.5 pr-3">Component</th>
                  <th className="py-0.5 pr-3">Value</th>
                  <th className="py-0.5">References</th>
                </tr>
              </thead>
              <tbody>
                {bom.map((row, i) => (
                  <tr key={i} className="border-b border-neutral-200 align-top">
                    <td className="py-0.5 pr-3">{row.qty}</td>
                    <td className="py-0.5 pr-3">{row.defName}</td>
                    <td className="py-0.5 pr-3">{row.value || "-"}</td>
                    <td className="py-0.5">{row.refs.join(", ")}</td>
                  </tr>
                ))}
                {bom.length === 0 && (
                  <tr><td colSpan={4} className="py-2 text-neutral-500">No components.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          )}
          {nothingSelected && (
            <div className="p-[10mm] text-sm text-neutral-500">
              Nothing selected. Enable Component sheet, Cut sheet, or BOM above.
            </div>
          )}
        </div>
      </div>
    </div>
    </div>,
    document.body
  );
}
