import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";
import ProjectToolbar from "@/components/ProjectToolbar";

export default function Home() {
  return (
    <div className="flex flex-col h-screen bg-[#fafafa]">
      <ProjectToolbar />
      <div className="flex flex-1 min-h-0">
        <div className="w-1/2 border-r-2 border-[#113768]/20">
          <SchematicEditor />
        </div>
        <div className="w-1/2">
          <StripboardEditor />
        </div>
      </div>
    </div>
  );
}
