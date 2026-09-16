import { ProtectedPage } from '@/components/ProtectedPage';
import { BrandSuggestionFormPage } from '@/screens/BrandSuggestionFormPage';

export default function SuggestionFormRoute() {
  return (
    <ProtectedPage businessToolsOnly requiredModule="generator">
      <BrandSuggestionFormPage />
    </ProtectedPage>
  );
}
