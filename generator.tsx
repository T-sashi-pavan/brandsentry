import { ProtectedPage } from '@/components/ProtectedPage';
import { AIGeneratorPage } from '@/screens/AIGeneratorPage';

export default function GeneratorRoute() {
  return (
    <ProtectedPage businessToolsOnly requiredModule="generator">
      <AIGeneratorPage />
    </ProtectedPage>
  );
}
