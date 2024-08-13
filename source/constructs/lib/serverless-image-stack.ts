// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PriceClass } from "aws-cdk-lib/aws-cloudfront";
import { Fn, Aws, Aspects, CfnOutput, CfnParameter, Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import { SuppressLambdaFunctionCfnRulesAspect } from "../utils/aspects";
import { BackEnd } from "./back-end/back-end-construct";
import { BackEndProps, AppRegistryApplicationProps } from "./types";
import * as appreg from "@aws-cdk/aws-servicecatalogappregistry-alpha";

export interface ServerlessImageHandlerStackProps extends StackProps {
  readonly solutionId: string;
  readonly solutionName: string;
  readonly solutionVersion: string;
  readonly stageName: string;
}

export class ServerlessImageHandlerStack extends Stack {
  constructor(scope: Construct, id: string, props: ServerlessImageHandlerStackProps) {
    super(scope, id, props);

    const corsEnabledParameter = new CfnParameter(this, "CorsEnabledParameter", {
      type: "String",
      description: `Would you like to enable Cross-Origin Resource Sharing (CORS) for the image handler API? Select 'Yes' if so.`,
      allowedValues: ["Yes", "No"],
      default: "No",
    });

    const corsOriginParameter = new CfnParameter(this, "CorsOriginParameter", {
      type: "String",
      description: `If you selected 'Yes' above, please specify an origin value here. A wildcard (*) value will support any origin. We recommend specifying an origin (i.e. https://example.domain) to restrict cross-site access to your API.`,
      default: "*",
    });

    const sourceBucketsParameter = new CfnParameter(this, "SourceBucketsParameter", {
      type: "String",
      description:
        "(Required) List the buckets (comma-separated) within your account that contain original image files. If you plan to use Thumbor or Custom image requests with this solution, the source bucket for those requests will default to the first bucket listed in this field.",
      allowedPattern: ".+",
      default: "defaultBucket, bucketNo2, bucketNo3, ...",
    });

    const logRetentionPeriodParameter = new CfnParameter(this, "LogRetentionPeriodParameter", {
      type: "Number",
      description:
        "This solution automatically logs events to Amazon CloudWatch. Select the amount of time for CloudWatch logs from this solution to be retained (in days).",
      allowedValues: [
        "1",
        "3",
        "5",
        "7",
        "14",
        "30",
        "60",
        "90",
        "120",
        "150",
        "180",
        "365",
        "400",
        "545",
        "731",
        "1827",
        "3653",
      ],
      default: "1",
    });

    const cloudFrontPriceClassParameter = new CfnParameter(this, "CloudFrontPriceClassParameter", {
      type: "String",
      description:
        "The AWS CloudFront price class to use. For more information see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PriceClass.html",
      allowedValues: [PriceClass.PRICE_CLASS_ALL, PriceClass.PRICE_CLASS_200, PriceClass.PRICE_CLASS_100],
      default: PriceClass.PRICE_CLASS_ALL,
    });

    const backendProps: BackEndProps = {
      corsEnabled: corsEnabledParameter.valueAsString,
      corsOrigin: corsOriginParameter.valueAsString,
      sourceBuckets: sourceBucketsParameter.valueAsString,
      logRetentionPeriod: logRetentionPeriodParameter.valueAsNumber,
      
      solutionVersion: props.solutionVersion,
      solutionId: props.solutionId,
      solutionName: props.solutionName,
      cloudFrontPriceClass: cloudFrontPriceClassParameter.valueAsString,
      stageName: props.stageName,

      createSourceBucketsResource: this.createSourceBucketsResource,
      };
    
    const backEnd = new BackEnd(this, "BackEnd", backendProps);

    this.appRegistryApplication({
      description: `${props.solutionId} - ${props.solutionName}. Version ${props.solutionVersion}`,
      solutionVersion: props.solutionVersion,
      solutionId: props.solutionId,
      applicationName: props.solutionName,
    });

    this.templateOptions.metadata = {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          {
            Label: { default: "CORS Options" },
            Parameters: [corsEnabledParameter.logicalId, corsOriginParameter.logicalId],
          },
          {
            Label: { default: "Image Sources" },
            Parameters: [sourceBucketsParameter.logicalId],
          },
          {
            Label: { default: "Event Logging" },
            Parameters: [logRetentionPeriodParameter.logicalId],
          },
        ],
        ParameterLabels: {
          [corsEnabledParameter.logicalId]: { default: "CORS Enabled" },
          [corsOriginParameter.logicalId]: { default: "CORS Origin" },
          [sourceBucketsParameter.logicalId]: { default: "Source Buckets" },
          [logRetentionPeriodParameter.logicalId]: {
            default: "Log Retention Period",
          },
          [cloudFrontPriceClassParameter.logicalId]: {
            default: "CloudFront PriceClass",
          },
        },
      },
    };

    /* eslint-disable no-new */
    new CfnOutput(this, "ApiEndpoint", {
      value: `https://${backEnd.domainName}`,
      description: "Link to API endpoint for sending image requests to.",
    });
    new CfnOutput(this, "SourceBuckets", {
      value: sourceBucketsParameter.valueAsString,
      description: "Amazon S3 bucket location containing original image files.",
    });
    new CfnOutput(this, "CorsEnabled", {
      value: corsEnabledParameter.valueAsString,
      description: "Indicates whether Cross-Origin Resource Sharing (CORS) has been enabled for the image handler API.",
    });
    new CfnOutput(this, "LogRetentionPeriod", {
      value: logRetentionPeriodParameter.valueAsString,
      description: "Number of days for event logs from Lambda to be retained in CloudWatch.",
    });

    Aspects.of(this).add(new SuppressLambdaFunctionCfnRulesAspect());
    Tags.of(this).add("SolutionId", props.solutionId);
  }

  public createSourceBucketsResource(resourceName: string = "") {
    return Fn.split(
      ',',
      Fn.sub(
        `arn:aws:s3:::\${rest}${resourceName}`,

        {
          rest: Fn.join(
            `${resourceName},arn:aws:s3:::`,
            Fn.split(",", Fn.join("", Fn.split(" ", Fn.ref('SourceBucketsParameter'))))
          ),
        },
      ),
    )
  }

  public appRegistryApplication(props: AppRegistryApplicationProps) {
    const stack = Stack.of(this);
    const applicationType = "AWS-Solutions";

    const application = new appreg.Application(stack, "AppRegistry", {
      applicationName: Fn.join("-", ["AppRegistry", Aws.STACK_NAME, Aws.REGION, Aws.ACCOUNT_ID]),
      description: `Service Catalog application to track and manage all your resources for the solution ${props.applicationName}`,
    });
    application.associateApplicationWithStack(stack);

    Tags.of(application).add("Solutions:SolutionID", props.solutionId);
    Tags.of(application).add("Solutions:SolutionName", props.applicationName);
    Tags.of(application).add("Solutions:SolutionVersion", props.solutionVersion);
    Tags.of(application).add("Solutions:ApplicationType", applicationType);

    const attributeGroup = new appreg.AttributeGroup(stack, "DefaultApplicationAttributeGroup", {
      attributeGroupName: `A30-AppRegistry-${Aws.STACK_NAME}`,
      description: "Attribute group for solution information",
      attributes: {
        applicationType,
        version: props.solutionVersion,
        solutionID: props.solutionId,
        solutionName: props.applicationName,
      },
    });
    attributeGroup.associateWith(application);
  }
}
