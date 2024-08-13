// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App } from "aws-cdk-lib";
import { ServerlessImageHandlerStack } from "../lib/serverless-image-stack";

// Solutions pipeline deployment
const { REGION, ACCOUNT, STAGE, SOLUTION_NAME, VERSION } = process.env;

  
const app = new App();
const solutionDisplayName = "Serverless Image Handler";
const solutionVersion = VERSION ?? app.node.tryGetContext("solutionVersion");
const description = `(${app.node.tryGetContext("solutionId")}) - ${solutionDisplayName}. Version ${solutionVersion}`;
const stageName = STAGE ?? app.node.tryGetContext("stage");
// eslint-disable-next-line no-new
new ServerlessImageHandlerStack(app, "ServerlessImageHandlerStack", {
  description,
  solutionId: app.node.tryGetContext("solutionId"),
  solutionVersion,
  solutionName: app.node.tryGetContext("solutionName"),
  stageName: stageName,
  env: { account: ACCOUNT, region: REGION }
});
