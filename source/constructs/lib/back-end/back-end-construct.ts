// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as path from "path";
//import { createHash } from "crypto";
//import moment from "moment";
import { LambdaRestApiProps, RestApi } from "aws-cdk-lib/aws-apigateway";
import {
  AllowedMethods,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  DistributionProps,
  IOrigin,
  OriginRequestPolicy,
  OriginSslPolicy,
  PriceClass,
  ViewerProtocolPolicy
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
//import S3C, { CreateBucketRequest, PutBucketEncryptionRequest, PutBucketPolicyRequest } from "aws-sdk/clients/s3";
import { ArnFormat, Aws, Duration, Lazy, Stack, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CloudFrontToApiGatewayToLambda } from "@aws-solutions-constructs/aws-cloudfront-apigateway-lambda";
import { addCfnSuppressRules } from "../../utils/utils";
import { BackEndProps } from "../types";
import * as api from "aws-cdk-lib/aws-apigateway";
//import { getOptions } from "../../../image-handler/index";

export class BackEnd extends Construct {
  public domainName: string;

  constructor(scope: Construct, id: string, props: BackEndProps) {
    super(scope, id);

    const imageHandlerLambdaFunctionRole = new Role(this, "ImageHandlerFunctionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      path: "/",
    });

    const imageHandlerLambdaFunctionRolePolicy = new Policy(this, "ImageHandlerFunctionPolicy", {
      statements: [
        new PolicyStatement({
          actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [
            Stack.of(this).formatArn({
              service: "logs",
              resource: "log-group",
              resourceName: "/aws/lambda/*",
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: props.createSourceBucketsResource("/*"),
        }),
        new PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: props.createSourceBucketsResource(),
        }),
        new PolicyStatement({
          actions: ["rekognition:DetectFaces", "rekognition:DetectModerationLabels"],
          resources: ["*"],
        }),
      ],
    });

    // s3 access policy for image handler lambda function
    // imageHandlerLambdaFunctionRole.addToRolePolicy(new iam.PolicyStatement({
    //   effect: iam.Effect.ALLOW,
    //   actions: [
    //     "s3:GetObject",
    //     "s3:PutObject",
    //     "s3:ListBucket",
    //   ],
    //   resources: [
    //     "arn:aws:s3:::*",
    //   ],
    // }));

    addCfnSuppressRules(imageHandlerLambdaFunctionRolePolicy, [
      { id: "W12", reason: "rekognition:DetectFaces requires '*' resources." },
    ]);
    imageHandlerLambdaFunctionRole.attachInlinePolicy(imageHandlerLambdaFunctionRolePolicy);

    const imageHandlerLambdaFunction = new NodejsFunction(this, "ImageHandlerLambdaFunction", {
      description: `${props.solutionName} (${props.solutionVersion}): Performs image edits and manipulations`,
      memorySize: 1024,
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(29),
      role: imageHandlerLambdaFunctionRole,
      entry: path.join(__dirname, "../../../image-handler/index.ts"),
      environment: {
        AUTO_WEBP: "No",
        CORS_ENABLED: props.corsEnabled,
        CORS_ORIGIN: props.corsOrigin,
        SOURCE_BUCKETS: props.sourceBuckets,
        REWRITE_MATCH_PATTERN: "",
        REWRITE_SUBSTITUTION: "",
        SOLUTION_VERSION: props.solutionVersion,
        SOLUTION_ID: props.solutionId,
      },
      bundling: {
        externalModules: ["sharp"],
        nodeModules: ["sharp"],
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [];
          },
          beforeInstall(inputDir: string, outputDir: string): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cd ${outputDir}`, "rm -rf node_modules/sharp && npm install --arch=x64 --platform=linux sharp"];
          },
        },
      },
    });

    const imageHandlerLogGroup = new LogGroup(this, "ImageHandlerLogGroup", {
      logGroupName: `/aws/lambda/${imageHandlerLambdaFunction.functionName}`,
      retention: props.logRetentionPeriod as RetentionDays,
    });

    addCfnSuppressRules(imageHandlerLogGroup, [
      {
        id: "W84",
        reason: "CloudWatch log group is always encrypted by default.",
      },
    ]);

    const bucketSuffix = `${Aws.STACK_NAME}-${Aws.REGION}-${Aws.ACCOUNT_ID}`;

    // log bucket for cloudfront
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `s3-logbucket-image-handler-lambda-function-${props.stageName}`,
      removalPolicy: RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER, // Set ObjectOwnership to ObjectWriter
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE, // Set ACL to log-delivery-write

      // objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // Enable ACLs for the bucket
      // publicReadAccess: false, // Keep the bucket private
      // enforceSSL: true, // Optional: ensure SSL is enforced
      // blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Optional: ensure the bucket is not publicly accessible
    });

    const cachePolicy = new CachePolicy(this, "CachePolicy", {
      cachePolicyName: `ServerlessImageHandler`,
      defaultTtl: Duration.days(1),
      minTtl: Duration.seconds(1),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: false,
      headerBehavior: CacheHeaderBehavior.allowList("origin", "accept"),
      queryStringBehavior: CacheQueryStringBehavior.allowList("signature"),
    });

    const originRequestPolicy = new OriginRequestPolicy(this, "OriginRequestPolicy", {
      originRequestPolicyName: `ServerlessImageHandler`,
      headerBehavior: CacheHeaderBehavior.allowList("origin", "accept"),
      queryStringBehavior: CacheQueryStringBehavior.allowList("signature"),
    });

    const apiGatewayRestApi = RestApi.fromRestApiId(
      this,
      "ApiGatewayRestApi",
      Lazy.string({
        produce: () => imageHandlerCloudFrontApiGatewayLambda.apiGateway.restApiId,
      })
    );

    const origin: IOrigin = new HttpOrigin(`${apiGatewayRestApi.restApiId}.execute-api.${Aws.REGION}.amazonaws.com`, {
      originPath: "/image",
      originSslProtocols: [OriginSslPolicy.TLS_V1_1, OriginSslPolicy.TLS_V1_2],
    });

    const cloudFrontDistributionProps: DistributionProps = {
      comment: "Image Handler Distribution for Serverless Image Handler",
      defaultBehavior: {
        origin,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        originRequestPolicy,
        cachePolicy,
      },
      priceClass: props.cloudFrontPriceClass as PriceClass,
      enableLogging: true,
      logBucket: logBucket,
      logFilePrefix: "api-cloudfront/",
      errorResponses: [
        { httpStatus: 500, ttl: Duration.minutes(10) },
        { httpStatus: 501, ttl: Duration.minutes(10) },
        { httpStatus: 502, ttl: Duration.minutes(10) },
        { httpStatus: 503, ttl: Duration.minutes(10) },
        { httpStatus: 504, ttl: Duration.minutes(10) },
      ],
    };

    const logGroupProps = {
      retention: props.logRetentionPeriod as RetentionDays,
    };

    const apiGatewayProps: LambdaRestApiProps = {
      handler: imageHandlerLambdaFunction,
      deployOptions: {
        stageName: props.stageName,
      },
      binaryMediaTypes: ["*/*"],
      defaultMethodOptions: {
        authorizationType: api.AuthorizationType.NONE,
      },
    };

    const imageHandlerCloudFrontApiGatewayLambda = new CloudFrontToApiGatewayToLambda(
      this,
      "ImageHandlerCloudFrontApiGatewayLambda",
      {
        existingLambdaObj: imageHandlerLambdaFunction,
        insertHttpSecurityHeaders: false,
        logGroupProps,
        cloudFrontDistributionProps,
        apiGatewayProps,
      }
    );

    addCfnSuppressRules(imageHandlerCloudFrontApiGatewayLambda.apiGateway, [
      {
        id: "W59",
        reason:
          "AWS::ApiGateway::Method AuthorizationType is set to 'NONE' because API Gateway behind CloudFront does not support AWS_IAM authentication",
      },
    ]);

    imageHandlerCloudFrontApiGatewayLambda.apiGateway.node.tryRemoveChild("Endpoint"); // we don't need the RestApi endpoint in the outputs

    this.domainName = imageHandlerCloudFrontApiGatewayLambda.cloudFrontWebDistribution.distributionDomainName;
  }

  // async function createCloudFrontLoggingBucket(requestProperties: CreateLoggingBucketRequestProperties) {
  //   const logBucketSuffix = createHash("md5")
  //     .update(`${requestProperties.BucketSuffix}${moment.utc().valueOf()}`)
  //     .digest("hex");
  //   const bucketName = `serverless-image-handler-logs-${logBucketSuffix.substring(0, 8)}`.toLowerCase();
  
  //   // the S3 bucket will be created in 'us-east-1' if the current region is in opt-in regions,
  //   // because CloudFront does not currently deliver access logs to opt-in region buckets
  //   const isOptInRegion = await checkRegionOptInStatus(AWS_REGION);
  //   const targetRegion = isOptInRegion ? "us-east-1" : AWS_REGION;
  //   console.info(
  //     `The opt-in status of the '${AWS_REGION}' region is '${isOptInRegion ? "opted-in" : "opt-in-not-required"}'`
  //   );
  
  //   // create bucket
  //   try {
  //     const awsSdkOptions = getOptions();
  //     const s3Client = new S3C({
  //       ...awsSdkOptions,
  //       apiVersion: "2006-03-01",
  //       region: targetRegion,
  //     });
  
  //     const createBucketRequestParams: CreateBucketRequest = {
  //       Bucket: bucketName,
  //       ACL: "log-delivery-write",
  //       ObjectOwnership: "ObjectWriter",
  //     };
  //     await s3Client.createBucket(createBucketRequestParams).promise();
  
  //     console.info(`Successfully created bucket '${bucketName}' in '${targetRegion}' region`);
  //   } catch (error) {
  //     console.error(`Could not create bucket '${bucketName}'`);
  //     console.error(error);
  
  //     throw error;
  //   }
  
  //   // add encryption to bucket
  //   console.info("Adding Encryption...");
  //   try {
  //     const putBucketEncryptionRequestParams: PutBucketEncryptionRequest = {
  //       Bucket: bucketName,
  //       ServerSideEncryptionConfiguration: {
  //         Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
  //       },
  //     };
  
  //     await s3Client.putBucketEncryption(putBucketEncryptionRequestParams).promise();
  
  //     console.info(`Successfully enabled encryption on bucket '${bucketName}'`);
  //   } catch (error) {
  //     console.error(`Failed to add encryption to bucket '${bucketName}'`);
  //     console.error(error);
  
  //     throw error;
  //   }
  
  //   // add policy to bucket
  //   try {
  //     console.info("Adding policy...");
  
  //     const bucketPolicyStatement = {
  //       Resource: `arn:aws:s3:::${bucketName}/*`,
  //       Action: "*",
  //       Effect: "Deny",
  //       Principal: "*",
  //       Sid: "HttpsOnly",
  //       Condition: { Bool: { "aws:SecureTransport": "false" } },
  //     };
  //     const bucketPolicy = {
  //       Version: "2012-10-17",
  //       Statement: [bucketPolicyStatement],
  //     };
  //     const putBucketPolicyRequestParams: PutBucketPolicyRequest = {
  //       Bucket: bucketName,
  //       Policy: JSON.stringify(bucketPolicy),
  //     };
  
  //     await s3Client.putBucketPolicy(putBucketPolicyRequestParams).promise();
  
  //     console.info(`Successfully added policy to bucket '${bucketName}'`);
  //   } catch (error) {
  //     console.error(`Failed to add policy to bucket '${bucketName}'`);
  //     console.error(error);
  
  //     throw error;
  //   }
  
  //   // Add Stack tag
  //   try {
  //     console.info("Adding tag...");
  
  //     const taggingParams = {
  //       Bucket: bucketName,
  //       Tagging: {
  //         TagSet: [
  //           {
  //             Key: "stack-id",
  //             Value: requestProperties.StackId
  //           }]
  //       }
  //     };
  //     await s3Client.putBucketTagging(taggingParams).promise();
  
  //     console.info(`Successfully added tag to bucket '${bucketName}'`);
  //   } catch (error) {
  //     console.error(`Failed to add tag to bucket '${bucketName}'`);
  //     console.error(error);
  //     // Continue, failure here shouldn't block
  //   }
  
  //   return { BucketName: bucketName, Region: targetRegion };
  // }
}
