import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  customersApi, creatorsApi,
  type Customer, type Creator, type CreateCustomerInput,
} from '../../api/endpoints';

export interface UseCustomersDataResult {
  customers: Customer[];
  creators: Creator[];
  isLoading: boolean;
  isError: boolean;
  createCustomer: (input: CreateCustomerInput) => Promise<void>;
  exportCsv: () => Promise<void>;
}

export function useCustomersData(): UseCustomersDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const customers = useQuery({
    queryKey: ['customers', activeWorkspaceId],
    queryFn: () => customersApi.list({ limit: 200 }),
    enabled,
  });
  const creators = useQuery({
    queryKey: ['creators', activeWorkspaceId],
    queryFn: () => creatorsApi.list(),
    enabled,
  });

  const create = useMutation({
    mutationFn: (input: CreateCustomerInput) => customersApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] }),
  });

  return {
    customers: customers.data ?? [],
    creators: creators.data ?? [],
    isLoading: customers.isLoading,
    isError: customers.isError,
    createCustomer: async (input) => {
      await create.mutateAsync(input);
    },
    exportCsv: () => customersApi.exportCsv(),
  };
}
