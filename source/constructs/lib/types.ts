// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';

export interface BackEndProps extends cdk.StackProps {
  readonly corsEnabled: string;
  readonly corsOrigin: string;
  readonly sourceBuckets: string;
  readonly logRetentionPeriod: number;
  readonly solutionVersion: string;
  readonly solutionId: string;
  readonly solutionName: string;
  readonly cloudFrontPriceClass: string;
  readonly stageName: string;
  
  readonly createSourceBucketsResource: (key?: string) => string[];
}

export interface AppRegistryApplicationProps {
  readonly description: string;
  readonly solutionId: string;
  readonly applicationName: string;
  readonly solutionVersion: string;
}