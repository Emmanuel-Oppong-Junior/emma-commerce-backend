FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /stub
COPY server.mjs entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir /certs
EXPOSE 443 8080
ENTRYPOINT ["/stub/entrypoint.sh"]
