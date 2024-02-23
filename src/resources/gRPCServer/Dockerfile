FROM --platform=linux/arm64 node:18-alpine

ARG FUNCTION_DIR="/function"
RUN mkdir -p ${FUNCTION_DIR}
COPY src/* ${FUNCTION_DIR}
WORKDIR ${FUNCTION_DIR}
RUN yarn
RUN yarn tsc

EXPOSE 50051

CMD ["yarn", "start"]