import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";

export default function Home() {
  return (
    <div className="flex h-screen">
      <div className="w-1/2 border-r-2 border-neutral-400">
        <SchematicEditor />
      </div>
      <div className="w-1/2">
        <StripboardEditor />
      </div>
    </div>
  );
}
