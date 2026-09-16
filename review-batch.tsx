import { ProtectedPage } from '@/components/ProtectedPage';
import { ReviewBatchPage } from '@/screens/ReviewBatchPage';

export default function ReviewBatchRoute() {
  return (
    <ProtectedPage businessToolsOnly>
      <ReviewBatchPage />
    </ProtectedPage>
  );
}
