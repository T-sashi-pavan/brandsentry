import { ProtectedPage } from '@/components/ProtectedPage';

export default function NoAccessRoute() {
  return (
    <ProtectedPage>
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh] text-center px-6">
        <p className="text-lg font-semibold text-gray-700">No pages available for your role yet</p>
        <p className="text-sm text-gray-400 mt-1 max-w-sm">
          Trademark Team tools are coming soon. Check back once they're ready.
        </p>
      </div>
    </ProtectedPage>
  );
}
