import { useMutation } from '@tanstack/react-query';
import { authApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';

export function useTwoFactor() {
  const setTwoFactorEnabled = (enabled: boolean) => {
    const auth = useAuthStore.getState();
    if (auth.user) auth.setUser({ ...auth.user, twoFactorEnabled: enabled });
  };

  const enable = useMutation({
    mutationFn: (code: string) => authApi.enableTwoFactor(code),
    onSuccess: (result) => {
      const auth = useAuthStore.getState();
      if (auth.refreshToken) auth.setTokens(result.accessToken, auth.refreshToken);
      setTwoFactorEnabled(true);
    },
  });

  const disable = useMutation({
    mutationFn: (code: string) => authApi.disableTwoFactor(code),
    onSuccess: () => setTwoFactorEnabled(false),
  });

  const regenerateRecoveryCodes = useMutation({
    mutationFn: (code: string) => authApi.regenerateRecoveryCodes(code),
  });

  return { enable, disable, regenerateRecoveryCodes };
}
