import {
    type ApiChartAndResults,
    type ApiError,
    type ApiPaginatedQueryResults,
    type ApiQueryResults,
    type DashboardFilters,
    type DateGranularity,
    FeatureFlags,
    type MetricQuery,
    type PaginatedMetricQueryRequestParams,
    ParameterError,
    QueryExecutionContext,
    type SortField,
} from '@lightdash/common';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import { lightdashApi } from '../api';
import useDashboardContext from '../providers/Dashboard/useDashboardContext';
import {
    convertDateDashboardFilters,
    convertDateFilters,
} from '../utils/dateFilter';
import { useFeatureFlagEnabled } from './useFeatureFlagEnabled';
import useQueryError from './useQueryError';

export type QueryResultsProps = {
    projectUuid: string;
    tableId: string;
    query?: MetricQuery;
    csvLimit?: number | null; //giving null returns all results (no limit)
    chartUuid?: string;
    chartVersionUuid?: string;
    dateZoomGranularity?: DateGranularity;
    context?: string;
};

const getChartResults = async ({
    chartUuid,
    context,
}: {
    chartUuid?: string;
    context?: string;
}) => {
    return lightdashApi<ApiQueryResults>({
        url: `/saved/${chartUuid}/results${
            context ? `?context=${context}` : ''
        }`,
        method: 'POST',
        body: undefined,
    });
};

const getChartAndResults = async ({
    chartUuid,
    dashboardUuid,
    dashboardFilters,
    invalidateCache,
    dashboardSorts,
    granularity,
    autoRefresh,
    context,
}: {
    chartUuid?: string;
    dashboardUuid: string;
    dashboardFilters: DashboardFilters;
    invalidateCache?: boolean;
    dashboardSorts: SortField[];
    granularity?: DateGranularity;
    autoRefresh?: boolean;
    context?: string;
}) => {
    return lightdashApi<ApiChartAndResults>({
        url: `/saved/${chartUuid}/chart-and-results${
            context ? `?context=${context}` : ''
        }`,
        method: 'POST',
        body: JSON.stringify({
            dashboardUuid,
            dashboardFilters,
            dashboardSorts,
            granularity,
            ...(invalidateCache && { invalidateCache: true }),
            autoRefresh,
        }),
    });
};
const getQueryResults = async ({
    projectUuid,
    tableId,
    query,
    csvLimit,
    dateZoomGranularity,
    context,
}: QueryResultsProps) => {
    const timezoneFixQuery = query && {
        ...query,
        filters: convertDateFilters(query.filters),
        timezone: query.timezone ?? undefined,
    };

    return lightdashApi<ApiQueryResults>({
        url: `/projects/${projectUuid}/explores/${tableId}/runQuery`,
        method: 'POST',
        body: JSON.stringify({
            ...timezoneFixQuery,
            granularity: dateZoomGranularity,
            csvLimit,
            context,
        }),
    });
};

const getUnderlyingDataResults = async ({
    projectUuid,
    tableId,
    query,
}: {
    projectUuid: string;
    tableId: string;
    query: MetricQuery;
}) => {
    const timezoneFixQuery = {
        ...query,
        filters: convertDateFilters(query.filters),
    };

    return lightdashApi<ApiQueryResults>({
        url: `/projects/${projectUuid}/explores/${tableId}/runUnderlyingDataQuery`,
        method: 'POST',
        body: JSON.stringify(timezoneFixQuery),
    });
};

export const useUnderlyingDataResults = (
    tableId: string,
    query: MetricQuery,
) => {
    const { projectUuid } = useParams<{ projectUuid: string }>();
    const queryKey = [
        'underlyingDataResults',
        projectUuid,
        JSON.stringify(query),
    ];
    return useQuery<ApiQueryResults, ApiError>({
        queryKey,
        queryFn: () =>
            getUnderlyingDataResults({
                projectUuid: projectUuid!,
                tableId,
                query,
            }),
        retry: false,
    });
};

export const useChartAndResults = (
    chartUuid: string | null,
    dashboardUuid: string | null,
    dashboardFilters: DashboardFilters,
    dashboardSorts: SortField[],
    invalidateCache?: boolean,
    granularity?: DateGranularity,
    autoRefresh?: boolean,
    context?: string,
) => {
    const setChartsWithDateZoomApplied = useDashboardContext(
        (c) => c.setChartsWithDateZoomApplied,
    );
    const queryClient = useQueryClient();

    const sortKey =
        dashboardSorts
            ?.map((ds) => `${ds.fieldId}.${ds.descending}`)
            ?.join(',') || '';
    const queryKey = useMemo(
        () => [
            'savedChartResults',
            chartUuid,
            dashboardUuid,
            dashboardFilters,
            invalidateCache,
            sortKey,
            autoRefresh,
        ],
        [
            chartUuid,
            dashboardUuid,
            dashboardFilters,
            invalidateCache,
            sortKey,
            autoRefresh,
        ],
    );
    const apiChartAndResults =
        queryClient.getQueryData<ApiChartAndResults>(queryKey);

    const timezoneFixFilters =
        dashboardFilters && convertDateDashboardFilters(dashboardFilters);
    const hasADateDimension =
        !!apiChartAndResults?.metricQuery?.metadata?.hasADateDimension;

    const fetchChartAndResults = useCallback(
        () =>
            getChartAndResults({
                chartUuid: chartUuid!,
                dashboardUuid: dashboardUuid!,
                dashboardFilters: timezoneFixFilters,
                invalidateCache,
                dashboardSorts,
                granularity,
                autoRefresh,
                context,
            }),
        [
            chartUuid,
            dashboardUuid,
            timezoneFixFilters,
            invalidateCache,
            dashboardSorts,
            granularity,
            autoRefresh,
            context,
        ],
    );

    setChartsWithDateZoomApplied((prev) => {
        if (hasADateDimension) {
            if (granularity) {
                return (prev ?? new Set()).add(chartUuid!);
            }
            prev?.clear();
            return prev;
        }
        return prev;
    });

    return useQuery<ApiChartAndResults, ApiError>({
        queryKey:
            hasADateDimension && granularity
                ? queryKey.concat([granularity])
                : queryKey,
        queryFn: fetchChartAndResults,
        enabled: !!chartUuid && !!dashboardUuid,
        retry: false,
        refetchOnMount: false,
    });
};

const getChartVersionResults = async (
    chartUuid: string,
    versionUuid: string,
) => {
    return lightdashApi<ApiQueryResults>({
        url: `/saved/${chartUuid}/version/${versionUuid}/results`,
        method: 'POST',
        body: undefined,
    });
};

/**
 * Aggregates pagination results for a query
 */
const getQueryPaginatedResults = async (
    projectUuid: string,
    data: PaginatedMetricQueryRequestParams,
): Promise<ApiQueryResults & { queryUuid: string }> => {
    const firstPage = await lightdashApi<ApiPaginatedQueryResults>({
        url: `/projects/${projectUuid}/query`,
        version: 'v2',
        method: 'POST',
        body: JSON.stringify(data),
    });

    // Get all page rows in sequence
    let allRows: ApiPaginatedQueryResults['rows'] = firstPage.rows;
    let currentPage = firstPage;
    while (currentPage.nextPage) {
        currentPage = await lightdashApi<ApiPaginatedQueryResults>({
            url: `/projects/${projectUuid}/query`,
            version: 'v2',
            method: 'POST',
            body: JSON.stringify({
                queryUuid: firstPage.queryUuid,
                page: currentPage.nextPage,
            }),
        });
        allRows = allRows.concat(currentPage.rows);
    }
    return {
        queryUuid: firstPage.queryUuid,
        metricQuery: firstPage.metricQuery,
        cacheMetadata: {
            // todo: to be replaced once we have save query metadata in the DB
            cacheHit: false,
        },
        rows: allRows,
        fields: firstPage.fields,
    };
};

export const useQueryResults = (data: QueryResultsProps | null) => {
    const setErrorResponse = useQueryError({
        forceToastOnForbidden: true,
        forbiddenToastTitle: 'Error running query',
    });
    const queryPaginationEnabled = useFeatureFlagEnabled(
        FeatureFlags.QueryPagination,
    );
    const result = useQuery<ApiQueryResults, ApiError>({
        enabled: !!data,
        queryKey: ['query-all-results', data],
        queryFn: () => {
            if (data?.chartUuid && data?.chartVersionUuid) {
                return getChartVersionResults(
                    data.chartUuid,
                    data.chartVersionUuid,
                );
            } else if (data?.chartUuid) {
                return getChartResults(data);
            } else if (data?.query) {
                if (queryPaginationEnabled) {
                    const queryWithOverrides: PaginatedMetricQueryRequestParams =
                        {
                            context: QueryExecutionContext.EXPLORE,
                            query: {
                                ...data.query,
                                filters: convertDateFilters(data.query.filters),
                                timezone: data.query.timezone ?? undefined,
                                exploreName: data.tableId,
                                granularity: data.dateZoomGranularity,
                            },
                        };
                    return getQueryPaginatedResults(
                        data.projectUuid,
                        queryWithOverrides,
                    );
                }
                return getQueryResults(data);
            }

            return Promise.reject(
                new ParameterError('Missing QueryResultsProps'),
            );
        },
    });

    // On Error
    useEffect(() => {
        if (result.error) {
            setErrorResponse(result.error);
        }
    }, [result.error, setErrorResponse]);

    return result;
};
