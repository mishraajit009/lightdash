import {
    AnyType,
    CustomDimension,
    DimensionType,
    Field,
    ForbiddenError,
    formatDate,
    getItemLabel,
    getItemLabelWithoutTableName,
    GoogleSheetsTransientError,
    isDimension,
    isField,
    ItemsMap,
    Metric,
    MissingConfigError,
    TableCalculation,
    UnexpectedGoogleSheetsError,
} from '@lightdash/common';
import { google, sheets_v4 } from 'googleapis';
import { LightdashConfig } from '../../config/parseConfig';
import Logger from '../../logging/logger';

type GoogleDriveClientArguments = {
    lightdashConfig: LightdashConfig;
};

export class GoogleDriveClient {
    private readonly lightdashConfig: LightdashConfig;

    public isEnabled: boolean = false;

    constructor({ lightdashConfig }: GoogleDriveClientArguments) {
        this.lightdashConfig = lightdashConfig;
        this.isEnabled =
            lightdashConfig.auth.google.oauth2ClientId !== undefined &&
            lightdashConfig.auth.google.oauth2ClientSecret !== undefined;
    }

    private async getCredentials(refreshToken: string) {
        try {
            const credentials = {
                type: 'authorized_user',
                client_id: this.lightdashConfig.auth.google.oauth2ClientId,
                client_secret:
                    this.lightdashConfig.auth.google.oauth2ClientSecret,
                refresh_token: refreshToken,
            };
            const authClient = google.auth.fromJSON(credentials);
            return new google.auth.GoogleAuth({
                authClient,
            });
        } catch (err) {
            throw new ForbiddenError(`Failed to get credentials: ${err}`);
        }
    }

    private static async catchForbiddenError<T>(promise: Promise<T>) {
        try {
            return await promise;
        } catch (err: AnyType) {
            if (err?.response?.status === 401) {
                throw new ForbiddenError(
                    `Failed to authorize: ${err.response.data?.error}: ${err.response.data?.error_description}`,
                );
            }

            if (
                err?.response?.status === 400 &&
                err?.response?.data?.error === 'invalid_grant'
            ) {
                throw new ForbiddenError(
                    `Failed to refresh token: ${err.response.data.error}: ${err.response.data.error_description}`,
                );
            }

            throw err;
        }
    }

    async createNewTab(refreshToken: string, fileId: string, tabName: string) {
        if (!this.isEnabled) {
            throw new MissingConfigError('Google Drive is not enabled');
        }
        const auth = await this.getCredentials(refreshToken);
        const sheets = google.sheets({ version: 'v4', auth });

        // Creates a new tab in the sheet
        const tabTitle = tabName.replaceAll(':', '.'); // we can't use ranges with colons in their tab ids
        await GoogleDriveClient.catchForbiddenError(
            sheets.spreadsheets.batchUpdate({
                spreadsheetId: fileId,
                requestBody: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title: tabTitle,
                                },
                            },
                        },
                    ],
                },
            }),
        ).catch((error) => {
            if (
                error.code === 400 &&
                error?.errors[0]?.message.includes(tabName)
            ) {
                Logger.debug(
                    `Google sheet tab already exists, we will overwrite it: ${error.errors[0]?.message}`,
                );
            } else if (error.code === 500) {
                // This is a transient error, we will retry the request later
                throw new GoogleSheetsTransientError(error);
            }
        });

        return tabTitle;
    }

    async createNewSheet(refreshToken: string, title: string) {
        if (!this.isEnabled) {
            throw new MissingConfigError('Google Drive is not enabled');
        }
        const auth = await this.getCredentials(refreshToken);
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await GoogleDriveClient.catchForbiddenError(
            sheets.spreadsheets.create({
                requestBody: {
                    properties: {
                        title,
                    },
                },
            }),
        );
        return response.data;
    }

    async uploadMetadata(
        refreshToken: string,
        fileId: string,
        updateFrequency: string,
        tabs?: string[],
        reportUrl?: string,
    ) {
        if (!this.isEnabled) {
            throw new MissingConfigError('Google Drive is not enabled');
        }

        const metadataTabName = 'metadata';
        const auth = await this.getCredentials(refreshToken);
        const sheets = google.sheets({ version: 'v4', auth });
        await this.createNewTab(refreshToken, fileId, metadataTabName);

        await GoogleDriveClient.clearTabName(sheets, fileId, metadataTabName); // in case already exists

        const tabsUpdated = tabs
            ? tabs.map((t, i) => [i === 0 ? 'Tabs updated' : '', t])
            : [[]];
        const metadata: string[][] = [
            [
                'The data in this Google Sheet has been automatically synced via Lightdash',
            ],
            ['Update frequency:', updateFrequency],
            ['Time of last sync:', new Date().toLocaleString()],
            ...(reportUrl ? [['Report URL:', reportUrl]] : []),
            ...tabsUpdated,
        ];

        await GoogleDriveClient.catchForbiddenError(
            sheets.spreadsheets.values.update({
                spreadsheetId: fileId,
                range: `${metadataTabName}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: metadata,
                },
            }),
        );
    }

    private static async clearTabName(
        sheets: sheets_v4.Sheets,
        fileId: string,
        tabName?: string,
    ) {
        // The method "SheetId: 0" only works if the first default sheet tab still exists (it's not deleted by the user)
        // So instead we select all the cells in the first tab by its name
        try {
            if (tabName === undefined) {
                const spreadsheet = await GoogleDriveClient.catchForbiddenError(
                    sheets.spreadsheets.get({
                        spreadsheetId: fileId,
                    }),
                );
                const firstSheetName =
                    spreadsheet.data.sheets?.[0].properties?.title;
                if (!firstSheetName) {
                    throw new UnexpectedGoogleSheetsError(
                        'Unable to find the first sheet name in the spreadsheet',
                    );
                }
                Logger.debug(`Clearing first sheet name ${firstSheetName}`);
                await GoogleDriveClient.catchForbiddenError(
                    sheets.spreadsheets.values.clear({
                        spreadsheetId: fileId,
                        range: firstSheetName,
                    }),
                );
            } else {
                Logger.debug(`Clearing sheet name ${tabName}`);

                await GoogleDriveClient.catchForbiddenError(
                    sheets.spreadsheets.values.clear({
                        spreadsheetId: fileId,
                        range: tabName,
                    }),
                );
            }
        } catch (error) {
            Logger.error('Unable to clear the sheet', error);
            // Silently ignore this error
        }
    }

    static formatCell(
        value: AnyType,
        item?: Field | TableCalculation | CustomDimension | Metric,
    ) {
        // We don't want to use formatItemValue directly because the format for some types on Gsheets
        // is different to what we use to present the data in the UI (eg: timestamps, currencies)
        if (Array.isArray(value)) {
            return value.join(',');
        }
        if (value instanceof RegExp) {
            return value.source;
        }
        if (value instanceof Set) {
            return [...value].join(',');
        }

        if (isField(item) && item.type === DimensionType.DATE) {
            const timeInterval = isDimension(item)
                ? item.timeInterval
                : undefined;
            return formatDate(value, timeInterval);
        }
        // Return the string representation of the Object Wrappers for Primitive Types
        if (
            typeof value === 'object' &&
            (value instanceof Number ||
                value instanceof Boolean ||
                value instanceof String)
        ) {
            return value.valueOf();
        }

        if (value && typeof value === 'object' && !(value instanceof Date)) {
            return JSON.stringify(value);
        }
        return value;
    }

    async appendToSheet(
        refreshToken: string,
        fileId: string,
        csvContent: Record<string, string>[],
        itemMap: ItemsMap,
        showTableNames: boolean,

        tabName?: string,
        columnOrder: string[] = [],
        customLabels: Record<string, string> = {},
        hiddenFields: string[] = [],
    ) {
        if (!this.isEnabled) {
            throw new MissingConfigError('Google Drive is not enabled');
        }

        if (csvContent.length === 0) {
            Logger.info('No data to write to the sheet');
            return;
        }

        const sortedFieldIds = Object.keys(csvContent[0])
            .sort((a, b) => columnOrder.indexOf(a) - columnOrder.indexOf(b))
            .filter((id) => !hiddenFields.includes(id));

        const csvHeader = sortedFieldIds.map((id) => {
            if (customLabels[id]) {
                return customLabels[id];
            }
            if (itemMap[id]) {
                return showTableNames
                    ? getItemLabel(itemMap[id])
                    : getItemLabelWithoutTableName(itemMap[id]);
            }
            return id;
        });

        const values = csvContent.map((row) =>
            sortedFieldIds.map((fieldId) => {
                const item = itemMap[fieldId];
                // Google sheet doesn't like arrays as values, so we need to convert them to strings
                const value = row[fieldId];
                return GoogleDriveClient.formatCell(value, item);
            }),
        );

        await this.appendCsvToSheet(
            refreshToken,
            fileId,
            [csvHeader, ...values],
            tabName,
        );
    }

    async appendCsvToSheet(
        refreshToken: string,
        fileId: string,

        results: string[][],
        tabName?: string,
    ) {
        if (!this.isEnabled) {
            throw new MissingConfigError('Google Drive is not enabled');
        }

        if (results.length === 0) {
            Logger.info('No data to write to the sheet');
            return;
        }
        const auth = await this.getCredentials(refreshToken);
        const sheets = google.sheets({ version: 'v4', auth });

        let sanitizedTabName: string | undefined;
        if (tabName) {
            Logger.info(`Creating new tab ${tabName} on Google sheets`);
            sanitizedTabName = await this.createNewTab(
                refreshToken,
                fileId,
                tabName,
            );
        }
        // Clear first sheet before writting
        await GoogleDriveClient.clearTabName(sheets, fileId, tabName);

        Logger.info(
            `Writing ${results.length} rows and ${results[0].length} columns to Google sheets`,
        );

        await GoogleDriveClient.catchForbiddenError(
            sheets.spreadsheets.values.update({
                spreadsheetId: fileId,
                range: sanitizedTabName ? `${sanitizedTabName}!A1` : 'A1',
                valueInputOption: 'RAW',
                requestBody: {
                    values: results,
                },
            }),
        );
    }
}
