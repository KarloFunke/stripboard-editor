import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";

export default function Home() {
  return (
    <div className="flex h-screen bg-[#fafafa]">
      <div className="w-1/2 border-r-2 border-[#113768]/20">
        <SchematicEditor />
      </div>
      <div className="w-1/2">
        <StripboardEditor />
      </div>
    </div>
  );
}
