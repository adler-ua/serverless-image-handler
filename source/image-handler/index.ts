// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Rekognition from "aws-sdk/clients/rekognition";
import S3 from "aws-sdk/clients/s3";

import { ImageHandler } from "./image-handler";
import { ImageRequest } from "./image-request";
import { Headers, ImageHandlerEvent, ImageHandlerExecutionResult, StatusCodes } from "./lib";

const awsSdkOptions = getOptions();
const s3Client = new S3(awsSdkOptions);
const rekognitionClient = new Rekognition(awsSdkOptions);

/**
 * Image handler Lambda handler.
 * @param event The image handler request event.
 * @returns Processed request response.
 */
export async function handler(event: ImageHandlerEvent): Promise<ImageHandlerExecutionResult> {
  console.info("Received event:", JSON.stringify(event, null, 2));

  const imageRequest = new ImageRequest(s3Client);
  const imageHandler = new ImageHandler(s3Client, rekognitionClient);
  const isAlb = event.requestContext && Object.prototype.hasOwnProperty.call(event.requestContext, "elb");

  try {
    const imageRequestInfo = await imageRequest.setup(event);
    console.info(imageRequestInfo);

    const processedRequest = await imageHandler.process(imageRequestInfo);

    let headers = getResponseHeaders(false, isAlb);
    headers["Content-Type"] = imageRequestInfo.contentType;
    // eslint-disable-next-line dot-notation
    headers["Expires"] = imageRequestInfo.expires;
    headers["Last-Modified"] = imageRequestInfo.lastModified;
    headers["Cache-Control"] = imageRequestInfo.cacheControl;

    // Apply the custom headers overwriting any that may need overwriting
    if (imageRequestInfo.headers) {
      headers = { ...headers, ...imageRequestInfo.headers };
    }

    return {
      statusCode: StatusCodes.OK,
      isBase64Encoded: true,
      headers,
      body: processedRequest,
    };
  } catch (error) {
    console.error(error);
    const { statusCode, body } = getErrorResponse(error);
    return {
      statusCode,
      isBase64Encoded: false,
      headers: getResponseHeaders(true, isAlb),
      body,
    };
  }
}

/**
 * Generates the appropriate set of response headers based on a success or error condition.
 * @param isError Has an error been thrown.
 * @param isAlb Is the request from ALB.
 * @returns Headers.
 */
function getResponseHeaders(isError: boolean = false, isAlb: boolean = false): Headers {
  const { CORS_ENABLED, CORS_ORIGIN } = process.env;
  const corsEnabled = CORS_ENABLED === "Yes";
  const headers: Headers = {
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (!isAlb) {
    headers["Access-Control-Allow-Credentials"] = true;
  }

  if (corsEnabled) {
    headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
  }

  if (isError) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

/**
 * Determines the appropriate error response values
 * @param error The error object from a try/catch block
 * @returns appropriate status code and body
 */
export function getErrorResponse(error) {
  if (error?.status) {
    return {
      statusCode: error.status,
      body: JSON.stringify(error),
    };
  }
  /**
   * if an image overlay is attempted and the overlaying image has greater dimensions
   * that the base image, sharp will throw an exception and return this string
   */
  if (error?.message === "Image to composite must have same dimensions or smaller") {
    return {
      statusCode: StatusCodes.BAD_REQUEST,
      body: JSON.stringify({
        /**
         * return a message indicating overlay dimensions is the issue, the caller may not
         * know that the sharp composite function was used
         */
        message: "Image to overlay must have same dimensions or smaller",
        code: "BadRequest",
        status: StatusCodes.BAD_REQUEST,
      }),
    };
  }
  return {
    statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
    body: JSON.stringify({
      message: "Internal error. Please contact the system administrator.",
      code: "InternalError",
      status: StatusCodes.INTERNAL_SERVER_ERROR,
    }),
  };
}

export function getOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
  const { SOLUTION_ID, SOLUTION_VERSION } = process.env;
  if (SOLUTION_ID && SOLUTION_VERSION) {
    if (SOLUTION_ID.trim() !== "" && SOLUTION_VERSION.trim() !== "") {
      options.customUserAgent = `AwsSolution/${SOLUTION_ID}/${SOLUTION_VERSION}`;
    }
  }

  return options;
}